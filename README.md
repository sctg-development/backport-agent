# Backport Agent

A deterministic IA powered agent for keeping a heavily customized Git fork in sync with an active upstream repository.

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

It is built to support a fork that includes features such as:

- the `keypoollive` provider;
- encrypted vault-backed model and key discovery;
- round-robin key rotation;
- GitHub Actions build-time package renaming;
- Mintlify documentation generation;
- a local reporting and validation workflow.

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

3. Set the required vault environment variables in your shell or `.env` file.

```bash
KEYPOOL_VAULT_URL=https://...
KEYPOOL_LIVE_SECRET=...
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

## Validation and tests

The repository includes both unit and integration coverage.

- `npm run typecheck` checks the TypeScript build.
- `npm test` runs the full test suite.
- `npm run test:unit` runs fast deterministic tests.
- `npm run test:integration` runs integration tests, including real KeypoolLive calls when your vault is configured.

The integration suite is intentionally practical. It verifies Git behavior in temporary repositories and exercises real SDK tools against the `keypoollive` provider with the `mistral/devstral-latest` model when `.env` is available.

## Configuration

The main runtime configuration lives in a JSON file modeled after [config.example.json](config.example.json). It defines:

- the upstream repository and branch;
- the fork repository and branch;
- the working directory;
- sync limits and batching;
- model selection;
- validation tiers.

Custom fork invariants live in a YAML file modeled after [customizations.example.yaml](customizations.example.yaml). This is where you describe the areas that must not be broken by a backport run.

## For contributors

Contributions are especially welcome in the following areas:

- additional integration tests for more SDK tools and runtime behaviors;
- stronger customization detection and risk classification;
- better report formatting and human-review summaries;
- more realistic validation strategies for large forks;
- documentation improvements and onboarding examples;
- support for additional providers or model-routing strategies.

If you are looking for a good first contribution, start with tests or documentation. The project already has a deterministic core, so incremental improvements are easy to verify.

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