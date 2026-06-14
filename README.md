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
- produce a clear report instead of pushing blind changes.

## What it does

The agent works as a sync pipeline rather than a one-shot merge bot. It reads the upstream history, selects candidate commits, evaluates their risk, applies them in controlled batches, validates the result, and generates a report for review.

It is built to support forks that include features such as:

- custom LLM providers (e.g. `keypoollive` with encrypted vault-backed key rotation);
- build-time package renaming and CI workflow customizations;
- documentation generation pipelines;
- a local reporting and validation workflow.

## Key Features

- **Enhanced KeypoolLive Support**: Real-time event handling and token monitoring with comprehensive statistics tracking
- **Key Usage Reporting**: Detailed Markdown reports showing token usage by model and key
- **Improved Error Handling**: Enhanced timeout detection and verbose error reporting
- **Context Compaction**: Automatic conversation history compaction when approaching context limits
- **HTTP Debugging**: Optional debug fetch wrapper for detailed request/response logging
- **Benchmark Replay**: Compare different LLM models using existing prompt logs
- **User-Agent Logging**: Track API requests with detailed user-agent information

## How it is structured

The codebase is intentionally split into small, testable pieces:

- `src/git` handles Git operations and cherry-pick workflows;
- `src/risk` classifies commits and customization sensitivity;
- `src/validation` runs allowlisted validation commands;
- `src/github` manages pull request creation and metadata;
- `src/reports` assembles the final sync report;
- `src/ai` exposes analysis helpers used when deterministic logic is not enough;
- `src/config` and `src/customizations` load the sync configuration and fork-specific invariants.

The agent entry point is [src/main.ts](src/main.ts), which wires the sync flow together and also enables the built-in SDK tools used by the runtime.

## Getting started

1. Install dependencies.

```bash
npm install
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
ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY=sk-..., MISTRAL_API_KEY=..., etc.
```

You can also override the provider or API key at runtime without editing `config.json`:

```bash
npm start -- --provider anthropic --api-key sk-ant-...
```

4. Start the agent.

```bash
npm start
```

If you want a no-op run that still exercises the workflow, use:

```bash
npm run dry-run
```

Set `VERBOSE=true` to see detailed iteration and tool-call progress in stderr:

```bash
VERBOSE=true npm start
```

For enhanced HTTP debugging, set `BACKPORT_HTTP_DEBUG=verbose`:

```bash
BACKPORT_HTTP_DEBUG=verbose npm start
```

## Retry behavior

The agent includes automatic retry logic for transient provider errors (rate limits, overloaded endpoints, high-demand responses, HTTP 503, etc.). When a retriable error is detected, the agent waits with exponential backoff (15 s, 30 s, 45 s…) and restarts up to 5 times.

Because agent state is anchored to Git, restarting is safe — already-applied commits are detected from the git log and skipped automatically.

The iteration counter in verbose output is continuous across retries. A retry is indicated by a suffix in the progress lines:

```
--- iteration 16 ---
[Retry] Silent provider error on attempt 1/5: This model is currently experiencing high demand…
[Retry] Waiting 15s before retrying...
--- iteration 17 - Retry 1 ---
--- iteration 18 - Retry 1 ---
```

## Key Usage Reporting

When using the `keypoollive` provider, the agent generates detailed key usage reports showing:

- Tokens by Model ID (input/output/total)
- Tokens by Key and Model ID
- Total usage statistics and key rotation events

This provides better visibility into API key usage patterns across different models.

## Context Management

The agent includes sophisticated context management features:

- **Soft Context Limits**: Injects wrap-up signals when approaching token limits
- **Hard Context Limits**: Aborts runs before context window overflow
- **Automatic Compaction**: Uses large-context summarizer models to compact conversation history
- **Context Budget Tracking**: Monitors token usage and provides warnings

## Debugging and Monitoring

Enhanced debugging capabilities are available:

- **HTTP Debug Mode**: Set `BACKPORT_HTTP_DEBUG=verbose` for detailed request/response logging
- **Timeout Detection**: Automatic detection and enhanced logging for timeout errors
- **Keypool Event Tracking**: Real-time visibility into key selection, rotation, and exhaustion events
- **Verbose Stack Traces**: Detailed error information in verbose mode

## Validation and tests

The repository includes both unit and integration coverage.

- `npm run typecheck` checks the TypeScript build.
- `npm test` runs the full test suite.
- `npm run test:unit` runs fast deterministic tests.
- `npm run test:integration` runs integration tests, including real KeypoolLive calls when your vault is configured.

The integration suite is intentionally practical. It verifies Git behavior in temporary repositories and exercises real SDK tools against a configured provider (defaults to `keypoollive` with the `mistral/devstral-latest` model) when `.env` is available.

## Configuration

The main runtime configuration lives in a JSON file modeled after [config.example.json](config.example.json). It defines:

- the upstream repository and branch;
- the fork repository and branch;
- the working directory;
- the LLM provider and model selection (`provider`, `fast`, `specialist`, `powerful`, `summarizer`);
- sync limits and batching;
- validation tiers;
- context management parameters.

The `provider` field in the `models` section is required. It accepts any provider ID supported by `@sctg/cline-sdk` (e.g. `"keypoollive"`, `"anthropic"`, `"openai"`, `"mistral"`, `"gemini"`). The API key is resolved from the `apiKey` field, a `$ENV_VAR` reference, or the implicit `{PROVIDER_UPPER}_API_KEY` environment variable.

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

**Example:** upstream commit `Move \`sdk/apps/\` to \`apps/\` (#11200)` is detected as already applied when the fork contains `feat(backport): Move sdk/apps/ to apps/ (cline#11200)` — the PR number matches and the similarity score (~0.67) exceeds the default threshold.

Enable this only when your team consistently includes the upstream PR number in manual backport commit messages.

### `ai` section — Quality guardrails (optional)

The optional `ai` section configures the AI quality guardrails introduced to improve backport reliability. All fields have safe defaults and the section can be omitted entirely.

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
| `minAutoApplyConfidence` | `"medium"` | Minimum AI confidence level (`"high"` or `"medium"`) to auto-apply a conflict resolution. Use `"high"` for stricter auto-apply. |
| `requireReviewOnSemanticRisk` | `false` | When `true`, any commit carrying semantic risk factors is escalated to `"review-required"` by `reconcile_ai_assessments`, regardless of the individual AI recommendations. |
| `enableConflictConsensus` | `false` | **Opt-in.** Runs a second, independent conflict resolution using `config.models.powerful` and compares both outputs with a Dice-coefficient similarity score. If the two resolutions diverge below `conflictConsensusThreshold`, confidence is downgraded to `"low"`. Enabling this roughly doubles LLM cost per conflict. |
| `conflictConsensusThreshold` | `0.7` | Minimum line-level similarity (0–1) required for consensus. Only used when `enableConflictConsensus: true`. |
| `enrichCustomizationContext` | `true` | When `true`, `check_customization_compatibility` reads up to 2 source files matching each customization glob (2 000 chars each) and injects their content into the AI prompt for richer analysis. |

### `models.summarizer` — Context compaction (optional)

For long-running sync operations, you can configure a separate large-context model for conversation compaction:

```json
"models": {
  "summarizer": {
    "provider": "anthropic",
    "modelId": "claude-3-5-sonnet-20240620",
    "apiKey": "$ANTHROPIC_API_KEY"
  }
}
```

When the conversation history approaches the context limit, the agent automatically uses this model to summarize the progress and continue processing remaining commits.

### AI sub-agent tools

The `src/ai` module exposes four tools that the main agent invokes when deterministic logic is not enough.

| Tool | Type | Purpose |
|---|---|---|
| `resolve_conflict_with_ai` | LLM call | Resolves merge conflicts in a single file using the configured `specialist` model. Returns `resolvedContent`, `confidence` (`"high"` / `"medium"` / `"low"`), and `reasoning`. Guards: conflict-marker detection, syntax balance check (JS/TS), optional dual-model consensus. |
| `analyze_commit_for_backport` | LLM call | Analyzes a commit diff to produce a summary, key changes, complexity estimate, semantic risk factors, and a backport `recommendation`. Also runs hallucination detection on referenced file paths. |
| `check_customization_compatibility` | LLM call | Checks whether a set of changes is compatible with the fork's declared customizations. Optionally enriches the prompt with actual file content when `ai.enrichCustomizationContext` is enabled. |
| `reconcile_ai_assessments` | Deterministic | **No LLM call.** Combines the outputs of the two analysis tools into a single `finalRecommendation`. Detects contradictions (e.g. analyze said "apply" but compatibility check failed), applies `requireReviewOnSemanticRisk` escalation, and always resolves ambiguity conservatively. Call this after both analysis tools have run for the same commit. |

Every LLM call is logged to the run's `.prompts.jsonl` file alongside structured quality signals (guards triggered, confidence, hallucination suspects). The detailed report includes a **Decision Quality Metrics** section summarising these signals across the full run.

#### Benchmark replay

The `src/tools/benchmark-replay.ts` script lets you compare two models side-by-side without running a full sync against a real repository. It reads an existing `.prompts.jsonl` log, replays every LLM call with the alternative model, and prints a Markdown comparison report.

```bash
npx tsx src/tools/benchmark-replay.ts \
  --log run-1780060224987.prompts.jsonl \
  --model anthropic/claude-sonnet-4-5 \
  --provider anthropic \
  --api-key "$ANTHROPIC_API_KEY" > comparison.md
```

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

**Example:** upstream commit `Move \`sdk/apps/\` to \`apps/\` (#11200)` is detected as already applied when the fork contains `feat(backport): Move sdk/apps/ to apps/ (cline#11200)` — the PR number matches and the similarity score (~0.67) exceeds the default threshold.

Enable this only when your team consistently includes the upstream PR number in manual backport commit messages.

### `ai` section — Quality guardrails (optional)

The optional `ai` section configures the AI quality guardrails introduced to improve backport reliability. All fields have safe defaults and the section can be omitted entirely.

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
| `minAutoApplyConfidence` | `"medium"` | Minimum AI confidence level (`"high"` or `"medium"`) to auto-apply a conflict resolution. Use `"high"` for stricter auto-apply. |
| `requireReviewOnSemanticRisk` | `false` | When `true`, any commit carrying semantic risk factors is escalated to `"review-required"` by `reconcile_ai_assessments`, regardless of the individual AI recommendations. |
| `enableConflictConsensus` | `false` | **Opt-in.** Runs a second, independent conflict resolution using `config.models.powerful` and compares both outputs with a Dice-coefficient similarity score. If the two resolutions diverge below `conflictConsensusThreshold`, confidence is downgraded to `"low"`. Enabling this roughly doubles LLM cost per conflict. |
| `conflictConsensusThreshold` | `0.7` | Minimum line-level similarity (0–1) required for consensus. Only used when `enableConflictConsensus: true`. |
| `enrichCustomizationContext` | `true` | When `true`, `check_customization_compatibility` reads up to 2 source files matching each customization glob (2 000 chars each) and injects their content into the AI prompt for richer analysis. |

### AI sub-agent tools

The `src/ai` module exposes four tools that the main agent invokes when deterministic logic is not enough.

| Tool | Type | Purpose |
|---|---|---|
| `resolve_conflict_with_ai` | LLM call | Resolves merge conflicts in a single file using the configured `specialist` model. Returns `resolvedContent`, `confidence` (`"high"` / `"medium"` / `"low"`), and `reasoning`. Guards: conflict-marker detection, syntax balance check (JS/TS), optional dual-model consensus. |
| `analyze_commit_for_backport` | LLM call | Analyzes a commit diff to produce a summary, key changes, complexity estimate, semantic risk factors, and a backport `recommendation`. Also runs hallucination detection on referenced file paths. |
| `check_customization_compatibility` | LLM call | Checks whether a set of changes is compatible with the fork's declared customizations. Optionally enriches the prompt with actual file content when `ai.enrichCustomizationContext` is enabled. |
| `reconcile_ai_assessments` | Deterministic | **No LLM call.** Combines the outputs of the two analysis tools into a single `finalRecommendation`. Detects contradictions (e.g. analyze said "apply" but compatibility check failed), applies `requireReviewOnSemanticRisk` escalation, and always resolves ambiguity conservatively. Call this after both analysis tools have run for the same commit. |

Every LLM call is logged to the run's `.prompts.jsonl` file alongside structured quality signals (guards triggered, confidence, hallucination suspects). The detailed report includes a **Decision Quality Metrics** section summarising these signals across the full run.

#### Benchmark replay

The `src/tools/benchmark-replay.ts` script lets you compare two models side-by-side without running a full sync against a real repository. It reads an existing `.prompts.jsonl` log, replays every LLM call with the alternative model, and prints a Markdown comparison report.

```bash
npx tsx src/tools/benchmark-replay.ts \
  --log run-1780060224987.prompts.jsonl \
  --model anthropic/claude-sonnet-4-5 \
  --provider anthropic \
  --api-key "$ANTHROPIC_API_KEY" > comparison.md
```

Custom fork invariants live in a YAML file modeled after [customizations.example.yaml](customizations.example.yaml). This is where you describe the areas that must not be broken by a backport run.



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

## Recent Improvements

### Version 0.6.1 (Current)

- **Key Usage Reporting**: Added `generateKeyUsageReport()` function for detailed token usage analysis
- **Enhanced KeypoolLive Support**: Comprehensive event handlers for key selection, rotation, and exhaustion
- **Improved Error Handling**: Better timeout detection and verbose error reporting
- **Context Management**: Automatic conversation compaction and context budget tracking
- **HTTP Debugging**: Optional debug fetch wrapper for detailed API request/response logging (`BACKPORT_HTTP_DEBUG=verbose`)
- **Configuration Updates**: Added support for summarizer models and enhanced context management

### Version 0.4.0

- **User-Agent Logging**: Improved retry iteration tracking and user-agent logging
- **Content Truncation**: Added `maxBytes` parameter to `getFileAtRef` for content truncation
- **File Reference Detection**: Improved file reference detection with customization support
- **Dependency Updates**: Upgraded all dependencies to latest versions

### Version 0.2.0

- **KeypoolLive Integration**: Full support for vault-based key rotation with real-time monitoring
- **Enhanced Logging**: Verbose logging and run summary reporting
- **AWS SDK Updates**: Updated all AWS SDK dependencies to latest versions

## Design principles

This project intentionally avoids the “merge everything and hope” approach. The main design goals are:

- preserve the fork’s intent;
- keep changes small and reviewable;
- use deterministic logic first;
- use AI only where it adds clear value;
- fail safely when confidence is low.

That makes the agent more useful for real maintenance work and easier for contributors to reason about.

## License

MIT License. See [LICENSE.md](LICENSE.md) for details.
