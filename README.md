[![Npm package version](https://badgen.net/npm/v/@sctg/backport-agent)](https://npmjs.com/package/@sctg/backport-agent)[![TypeScript](https://badgen.net/badge/icon/typescript?icon=typescript&label)](https://typescriptlang.org)
# Backport Agent

A deterministic AI-powered agent for keeping a heavily customized Git fork in sync with an active upstream repository.

This project is the implementation of the architecture described in [analysis.md](analysis.md). It is designed for the real-world case where a fork is not just a few patches on top of upstream, but a living codebase with custom providers, build-time rewrites, documentation changes, and operational workflows that must survive every sync.

## Why this exists

Keeping a fork aligned with upstream is hard when the fork carries important product decisions. A naive merge strategy can silently break custom behavior even when Git reports no conflicts.

Backport Agent focuses on the parts that matter most:

- identify the upstream commits that still need to be integrated;
- classify change risk before touching the fork;
- preserve fork-specific customizations;
- run validation after each meaningful integration step;
- produce a clear report — and a draft PR — instead of pushing blind changes;
- **enforce its safety rules in host code, not just in the model prompt**, so it can run unattended (daily cron/launchd).

## What it does

The agent works as a sync pipeline rather than a one-shot merge bot. It reads the upstream history, selects candidate commits, evaluates their risk, applies them in controlled batches, validates the result, opens or updates a draft pull request, and generates a report for review.

It is built to support forks that include features such as:

- custom LLM providers (e.g. `keypoollive` with encrypted vault-backed key rotation);
- build-time package renaming and CI workflow customizations;
- documentation generation pipelines;
- a local reporting and validation workflow.

## Key features

- **Host-side safety gates (v0.8.0)**: the critical rules are enforced in code, whatever the orchestrator model decides — see [Host-side gates](#host-side-gates-v080).
- **Meaningful exit codes**: `0` clean sync, `2` sync needs human attention, `1` fatal error — designed for cron wrappers.
- **Deterministic PR creation**: the report step itself creates/updates the draft sync PR (`sync.createPullRequest`).
- **Customization test execution**: `tests` declared in `customizations.yaml` run as trusted commands when the affected customizations are touched.
- **Enhanced KeypoolLive support**: real-time event handling, token monitoring, key-usage reports by model and key.
- **Context management**: soft/hard context limits, automatic compaction with a large-context summarizer model.
- **Benchmark replay**: compare two models on the prompt log of a past run without touching a real repository.
- **HTTP debugging**: optional debug fetch wrapper (`BACKPORT_HTTP_DEBUG=verbose`).

## Host-side gates (v0.8.0)

An unattended agent cannot rely on prompt-following alone. Since v0.8.0 a shared run state (`src/agent/run-state.ts`) is threaded through the tools and enforces:

| Gate | Behaviour |
|---|---|
| **Confidence gate** | `resolve_conflict_with_ai` records the *effective* confidence (after conflict-marker, syntax and consensus guards) of every resolution. `apply_resolved_file` **refuses to write** a resolution below `ai.minAutoApplyConfidence` and instructs the agent to abort the cherry-pick. |
| **Validation gate** | Every `run_validation` outcome is recorded. `auto_merge_pr` **refuses to merge** when validation failed or never ran. |
| **Report reconciliation** | `generate_report` cross-checks the model-provided summary against the recorded state: a failed validation suite can never be reported as a clean run. Gate activations appear in a dedicated *Host-side gate report* section. |
| **Exit code** | `main.ts` maps the outcome to the process exit code: `0` clean, `2` needs human attention (blocked commits, failed validation, fired gates, context abort), `1` fatal. |

## How it is structured

The codebase is intentionally split into small, testable pieces:

- `src/git` handles Git operations and cherry-pick workflows;
- `src/risk` classifies commits and customization sensitivity;
- `src/validation` runs config/manifest (trusted) and LLM-suggested (allowlisted) validation commands;
- `src/github` manages pull request creation, auto-merge and metadata;
- `src/reports` assembles the final sync report and creates/updates the sync PR;
- `src/ai` exposes analysis helpers used when deterministic logic is not enough;
- `src/agent` wires the agent loop: system prompt, retry logic, context compaction, host-side run state;
- `src/config` and `src/customizations` load the sync configuration and fork-specific invariants.

The agent entry point is [src/main.ts](src/main.ts), which wires the sync flow together and also enables the built-in SDK tools used by the runtime.

## Getting started

1. Install dependencies (bun and npm both work).

```bash
bun install        # or: npm install
```

2. Copy the example configuration files and adjust them for your environment.

- [config.example.json](config.example.json)
- [customizations.example.yaml](customizations.example.yaml)

3. Set the required provider credentials in your shell or `.env` file.

For the **keypoollive** provider (vault-based key rotation):

```bash
KEYPOOL_VAULT_URL=https://...
KEYPOOL_LIVE_SECRET=...
```

For any other provider supported by `@sctg/cline-sdk`, set the corresponding API key:

```bash
MISTRAL_API_KEY=...
# or GEMINI_API_KEY=..., COHERE_API_KEY=..., etc.
```

For PR creation (`sync.createPullRequest: true`), a `GITHUB_TOKEN` with `repo` scope is required (e.g. `export GITHUB_TOKEN="$(gh auth token)"`).

You can also override the provider or API key at runtime without editing `config.json`:

```bash
bun run start -- --provider mistral --api-key ...
```

4. Start the agent.

```bash
bun run start
```

If you want a no-op run that still exercises the workflow, use:

```bash
bun run dry-run
```

To list pending upstream commits without running the agent (cheap smoke test — no LLM calls):

```bash
node dist/main.mjs --list-backport-needed --config path/to/config.json
```

Set `VERBOSE=true` to see detailed iteration and tool-call progress in stderr, and `BACKPORT_HTTP_DEBUG=verbose` for detailed request/response logging.

## Daily unattended runs

`scripts/` contains a ready-to-use daily automation for macOS:

- [scripts/run-daily-sync.sh](scripts/run-daily-sync.sh) — wrapper with a single-instance lock, launchd-safe `PATH`, `GITHUB_TOKEN` derived from `gh auth token`, a local build of the agent, per-run logs in `~/Library/Logs/backport-agent/`, and a macOS notification when the run exits `2` (needs review) or `1` (failure).
- [scripts/org.sctg.backport-agent.plist](scripts/org.sctg.backport-agent.plist) — LaunchAgent running the wrapper daily at 07:15.

```bash
cp scripts/org.sctg.backport-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/org.sctg.backport-agent.plist
launchctl start org.sctg.backport-agent   # trigger a run immediately
```

Recommended rollout: keep `sync.autoMergeOnSuccess` disabled at first. Each daily run then pushes a sync branch and opens/updates a **draft PR** you can review in one glance; once you trust the pipeline, enabling auto-merge is safe because the merge is host-gated on validation.

## Retry behavior

The agent includes automatic retry logic for transient provider errors (rate limits, overloaded endpoints, high-demand responses, HTTP 503, etc.). When a retriable error is detected, the agent waits with exponential backoff (15 s, 30 s, 45 s…) and restarts up to 5 times.

Because agent state is anchored to Git (plus a within-run checkpoint file), restarting is safe — already-applied commits are detected and skipped automatically.

## Validation and tests

The repository includes both unit and integration coverage.

- `bun run typecheck` checks the TypeScript build.
- `bun run test` runs the full test suite.
- `bun run test:unit` runs fast deterministic tests (includes the host-gate and schema-alias tests).
- `bun run test:integration` runs integration tests, including real KeypoolLive calls when your vault is configured.

## Configuration

The main runtime configuration lives in a JSON file modeled after [config.example.json](config.example.json). It defines:

- the upstream repository and branch;
- the fork repository and branch;
- the working directory;
- the LLM provider and model selection (`provider`, `fast`, `specialist`, `powerful`, `summarizer`);
- sync limits and batching;
- validation tiers (`low` / `medium` / `high` / `final`);
- AI quality guardrails;
- context management parameters.

The `provider` field in the `models` section is required. It accepts any provider ID supported by `@sctg/cline-sdk` (e.g. `"keypoollive"`, `"mistral"`, `"gemini"`, `"cohere"`, `"openai"`, `"anthropic"`). The API key is resolved from the `apiKey` field, a `$ENV_VAR` reference, or the implicit `{PROVIDER_UPPER}_API_KEY` environment variable.

### Model roles

| Role | Used for | Guidance |
|---|---|---|
| `fast` | The orchestrator agent loop, small-diff analysis, report diagram | A reliable tool-calling model with a comfortable context window (the whole run lives in its context). |
| `specialist` | First attempt of every conflict resolution | **The most capable code model you have.** JSON-output reliability matters: a specialist that returns malformed JSON silently degrades resolutions. E.g. `mistral/mistral-medium-3-5`. |
| `powerful` | Conflict-resolution fallback, large-diff analysis, consensus second opinion | Ideally a **different vendor** than `specialist` so the consensus check is a real second opinion, with a large context window. E.g. `gemini/gemini-3.1-pro-preview`. |
| `summarizer` | Context compaction | A cheap large-context model. E.g. `gemini/gemini-3-flash-preview`. |

### `sync` section highlights

| Field | Default | Description |
|---|---|---|
| `maxCommitsPerRun` | `5` | Upper bound of commits processed per run. Size it against the `fast` model's context window (10 commits ≈ 170k+ tokens observed on a 262k model). |
| `createPullRequest` | `true` | When enabled, `generate_report` deterministically creates (or updates) the draft sync PR host-side. Requires `GITHUB_TOKEN`. |
| `autoMergeOnSuccess` | `false` | Allows `auto_merge_pr`, which is additionally host-gated on validation success. |
| `skipCommits` | `[]` | SHAs or subject patterns to always skip (release noise, docs churn…). |

### `sync.prNumberMatching` — Manual backport detection (optional)

By default, the agent detects already-applied commits using three signals: `git cherry` patch comparison, exact subject-line match, and the `cherry picked from commit <sha>` annotation added by `git cherry-pick -x`.

When a commit is cherry-picked manually (conflict resolution, subject rewrite, no `-x` flag), all three signals can miss it. Enabling `prNumberMatching` adds a fourth signal: if a fork commit references the same upstream PR number **and** the two subjects are similar enough (Jaccard word-token score), the commit is considered already applied.

```json
"sync": {
  "prNumberMatching": {
    "enabled": true,
    "minSubjectSimilarity": 0.4
  }
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `false` | Activate PR-number-based duplicate detection. |
| `minSubjectSimilarity` | `0.4` | Minimum Jaccard word-token similarity (0–1) between the upstream subject and the matching fork subject. Lower → more permissive (risk of false positives). Higher → stricter (may miss heavily reworded backports). |

Enable this only when your team consistently includes the upstream PR number in manual backport commit messages.

### `ai` section — Quality guardrails

```json
"ai": {
  "minAutoApplyConfidence": "medium",
  "requireReviewOnSemanticRisk": false,
  "enableConflictConsensus": false,
  "conflictConsensusThreshold": 0.7,
  "enrichCustomizationContext": true
}
```

| Field | Default | Description |
|---|---|---|
| `minAutoApplyConfidence` | `"medium"` | Minimum effective AI confidence to auto-apply a conflict resolution. **Enforced host-side since v0.8.0**: `apply_resolved_file` refuses resolutions below this threshold. Use `"high"` for stricter auto-apply. |
| `requireReviewOnSemanticRisk` | `false` | When `true`, any commit carrying semantic risk factors is escalated to `"review-required"` by `reconcile_ai_assessments`. |
| `enableConflictConsensus` | `false` | **Opt-in, recommended for unattended runs.** Runs a second, independent conflict resolution using `config.models.powerful` and compares both outputs with a Dice-coefficient similarity score. Divergence below `conflictConsensusThreshold` downgrades confidence to `"low"` — which the host confidence gate then blocks. Roughly doubles LLM cost per conflict. |
| `conflictConsensusThreshold` | `0.7` | Minimum line-level similarity (0–1) required for consensus. |
| `enrichCustomizationContext` | `true` | When `true`, `check_customization_compatibility` reads up to 2 source files matching each customization glob (2 000 chars each) and injects their content into the AI prompt. |

## Customizations manifest

Fork invariants live in a YAML file modeled after [customizations.example.yaml](customizations.example.yaml). Each entry describes one deliberate deviation from upstream:

```yaml
customizations:
  - id: keypoollive-provider
    description: Vault-backed key-rotation LLM provider
    paths:                    # globs OWNED by the customization → high risk
      - "sdk/packages/llms/src/providers/vendors/keypoollive.ts"
    related_files:            # shared wiring/registration points → at least medium risk
      - "apps/vscode/src/shared/api.ts"
    invariants:               # prose rules injected into AI conflict-resolution prompts
      - "The 'keypoollive' id must stay in the ApiProvider union."
    tests:                    # trusted shell commands run by run_validation
      - "bun run test:invariants"
```

Field semantics (since v0.8.0):

- `paths` — any upstream commit touching these globs is classified **high** risk and triggers the mandatory AI compatibility checks.
- `related_files` (alias `relatedFiles`) — files that interact with the customization without being owned by it; changes there raise risk to at least **medium** and pull in the entry's tests.
- `invariants` — human-readable rules; they are injected into the conflict-resolution prompt when the file overlaps the customization.
- `tests` (alias `testCommands`) — shell commands verifying the customization still works. The agent passes *customization IDs* (never command strings) to `run_validation`, which looks the commands up in the manifest and runs them via bash as **trusted** commands — they are user-authored configuration, exactly like `config.validation.*`.

A practical pattern: centralize all deterministic checks in one script in your fork (e.g. `check-fork-invariants.sh` exposed as `bun run test:invariants`), reference it from every entry's `tests`, and add it to every `config.validation` tier. Cheap (<1 s), and it runs even for low-risk commits.

## AI sub-agent tools

The `src/ai` module exposes four tools that the main agent invokes when deterministic logic is not enough.

| Tool | Type | Purpose |
|---|---|---|
| `resolve_conflict_with_ai` | LLM call | Resolves merge conflicts in a single file using the `specialist` model (fallback: `powerful`). Returns `resolvedContent`, `confidence` (`"high"` / `"medium"` / `"low"`), and `reasoning`. Guards: conflict-marker detection, syntax balance check (JS/TS), optional dual-model consensus. The effective confidence is recorded host-side for the apply gate. |
| `analyze_commit_for_backport` | LLM call | Analyzes a commit diff to produce a summary, key changes, complexity estimate, semantic risk factors, and a backport `recommendation`. Also runs hallucination detection on referenced file paths. |
| `check_customization_compatibility` | LLM call | Checks whether a set of changes is compatible with the fork's declared customizations. Optionally enriches the prompt with actual file content (`ai.enrichCustomizationContext`). |
| `reconcile_ai_assessments` | Deterministic | **No LLM call.** Combines the outputs of the two analysis tools into a single `finalRecommendation`, detects contradictions, applies `requireReviewOnSemanticRisk`, resolves ambiguity conservatively. |

Every LLM call is logged to the run's `.prompts.jsonl` file alongside structured quality signals (guards triggered, confidence, hallucination suspects). The detailed report includes a **Decision Quality Metrics** section summarising these signals across the full run.

### Benchmark replay

The `src/tools/benchmark-replay.ts` script lets you compare two models side-by-side without running a full sync against a real repository. It reads an existing `.prompts.jsonl` log, replays every LLM call with the alternative model, and prints a Markdown comparison report.

```bash
bunx tsx src/tools/benchmark-replay.ts \
  --log run-1780060224987.prompts.jsonl \
  --model mistral/mistral-medium-3-5 \
  --provider keypoollive > comparison.md
```

Use this before switching the `specialist` model: replay the conflicts of a past run and compare JSON validity, confidence distribution and resolution quality.

## For contributors

Contributions are especially welcome in the following areas:

- additional integration tests for more SDK tools and runtime behaviors;
- stronger customization detection and risk classification;
- better report formatting and human-review summaries;
- more realistic validation strategies for large forks;
- documentation improvements and onboarding examples;
- support for additional providers or model-routing strategies;
- enhanced context management and compaction strategies;
- improved key usage reporting and monitoring features;
- additional debugging and observability tools.

If you are looking for a good first contribution, start with tests or documentation. The project already has a deterministic core, so incremental improvements are easy to verify.

## Recent improvements

### Version 0.8.0 (current)

- **Host-side safety gates**: `ai.minAutoApplyConfidence` is now enforced in code by `apply_resolved_file`; `auto_merge_pr` is blocked when validation failed or never ran; `generate_report` reconciles the model's summary with the recorded run state.
- **Meaningful exit codes**: `0` clean / `2` needs human attention / `1` fatal — cron-friendly.
- **Customization tests actually run**: `tests`/`related_files` YAML keys are accepted (aliases of `testCommands`/`relatedFiles`) instead of being silently dropped by schema validation; `run_validation` resolves them by customization ID from the trusted manifest and runs them via bash.
- **`related_files` risk classification**: changes to registration/wiring files raise risk to at least medium and pull in the entry's tests.
- **Deterministic PR creation**: `sync.createPullRequest` is wired — the report step creates/updates the draft sync PR host-side (the old prompt-driven PR step never ran because `generate_report` terminates the run).
- **Daily automation**: `scripts/run-daily-sync.sh` + `scripts/org.sctg.backport-agent.plist` (macOS launchd).

### Version 0.6.1

- Key usage reporting, enhanced KeypoolLive event handling, improved timeout handling, context compaction, HTTP debugging, summarizer model support.

### Version 0.4.0

- User-agent logging, content truncation (`maxBytes`), improved file reference detection, dependency updates.

### Version 0.2.0

- KeypoolLive integration (vault-based key rotation), verbose logging and run summaries.

## Design principles

This project intentionally avoids the "merge everything and hope" approach. The main design goals are:

- preserve the fork's intent;
- keep changes small and reviewable;
- use deterministic logic first;
- use AI only where it adds clear value;
- fail safely when confidence is low — **and enforce that failure mode in code**.

That makes the agent more useful for real maintenance work and easier for contributors to reason about.

## License

MIT License. See [LICENSE.md](LICENSE.md) for details.
