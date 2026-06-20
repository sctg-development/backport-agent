---
title: "Backport-agent an ai assistant for backporting"
description: "An ai assistant for backporting code changes from upstream repositories"
framework: backport-agent
stack: "cline sdk"
generated: "2026-06-20"
slim_mode: false
files_total: 26
---

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

---

## Architecture overview

Backport-Agent is a **AI assisted tool for backporting commits from an upstream repository to a downstream repository**. It is designed to help developers automate the process of backporting changes, making it easier to maintain multiple versions of a codebase.

### Stack

---

## Project structure

```
└─ src
   ├─ agent
   │  ├─ agent-setup.ts
   │  ├─ context-compaction.ts
   │  ├─ event-handlers.ts
   │  ├─ retry-logic.ts
   │  └─ system-prompt.ts
   ├─ ai
   │  └─ ai-tools.ts
   ├─ cli
   │  └─ args.ts
   ├─ config
   │  ├─ loader.ts
   │  ├─ provider.ts
   │  └─ schema.ts
   ├─ customizations
   │  ├─ loader.ts
   │  └─ schema.ts
   ├─ git
   │  ├─ git-client.ts
   │  ├─ git-init.ts
   │  └─ git-tools.ts
   ├─ github
   │  └─ github-tools.ts
   ├─ main.ts
   ├─ reports
   │  ├─ context-abort-report.ts
   │  ├─ noop-report.ts
   │  └─ report-tools.ts
   ├─ risk
   │  ├─ classify-risk.ts
   │  └─ risk-tools.ts
   ├─ tool-helper.ts
   ├─ tools
   │  └─ benchmark-replay.ts
   └─ validation
      ├─ commands.ts
      └─ validation-tools.ts
```

## Source code

### `src/agent/agent-setup.ts`

**Exports:** setupAgent

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file agent-setup.ts
 *
 * Agent initialization and tool assembly for the Backport Agent.
 * Handles the creation and configuration of the agent with all necessary tools.
 */
import { Agent, createBuiltinTools, createUserInstructionConfigService } from "@sctg/cline-sdk"
import type { UserInstructionConfigRecord } from "@sctg/cline-sdk"
import type { AgentRuntimeHooks } from "@sctg/cline-agents"

type PrepareTurnContext = Parameters<NonNullable<AgentRuntimeHooks["prepareTurn"]>>[0]
import { loadCustomizations } from "../customizations/loader.js"
import { makeGitTools } from "../git/git-tools.js"
import { makeRiskTool } from "../risk/risk-tools.js"
import { makeValidationTool } from "../validation/validation-tools.js"
import { makeGitHubTools } from "../github/github-tools.js"
import { makeReportTool } from "../reports/report-tools.js"
import { makeAiTools } from "../ai/ai-tools.js"
import type { SyncConfig } from "../config/schema.js"
import { buildSystemPrompt } from "./system-prompt.js"
import { resolveApiKey } from "../config/provider.js"
import { compactConversation, getSummarizerConfig } from "./context-compaction.js"
import { Tiktoken } from "tiktoken/lite"
// Charger le JSON de manière synchrone compatible avec Bun
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const tiktokenPath = require.resolve("tiktoken/encoders/cl100k_base.json")
const cl100k_base = JSON.parse(readFileSync(tiktokenPath, 'utf-8'))


interface AgentSetupParams {
  config: SyncConfig
  promptLogPath: string
  verbose: boolean
}

interface KeyUsage {
  event: string
  owner: string
  keyHint: string
  modelId: string
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

interface AgentSetupResult {
  /** Factory that creates a fresh Agent for each retry attempt. */
  agentFactory: () => Agent
  userInstructionService: Awaited<ReturnType<typeof createUserInstructionConfigService>>
  keypoolStats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
    rotations: number
    exhaustions: number
    keysUsed: Set<KeyUsage>
    /** Input token count of the most recent successful LLM call (0 before first call). */
    lastInputTokens: number
  }
}

/**
 * Estimate the number of tokens in a string using the cl100k_base encoding.
 * This is a fast approximation and may not be exact for all models.
 * @param text - The input string to estimate token count for.
 * @returns The estimated number of tokens in the input string.
 */
function estimateTokens(text: string): number {
  const encoding = new Tiktoken(cl100k_base.bpe_ranks,
    cl100k_base.special_tokens,
    cl100k_base.pat_str)
  const tokens = encoding.encode(text)
  encoding.free()
  return tokens.length
}

/**
 * Extract the API Key from the Authorization header
 * @param authorizationHeader - The Authorization header value
 * @returns The extracted API Key or null if not found
 */
function extractApiKeyFromAuthorizationHeader(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null

  const match = authorizationHeader.match(/Bearer\s+(\S+)/i)
  return match ? match[1] : null
}

/**
 * Mask the center of an API Key for logging purposes, showing only the first and last 6 characters.
 * @param apiKey - The API Key to mask
 * @returns The masked API Key
 */
function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return apiKey // Too short to mask effectively
  const start = apiKey.slice(0, 6)
  const end = apiKey.slice(-6)
  return `${start}...${end}`
}

/**
 * Wraps the global fetch to log raw HTTP status codes and error bodies.
 * Enabled by BACKPORT_HTTP_DEBUG=true (or "verbose" for 2xx logging too).
 *
 * Purpose: distinguish between a genuine Mistral HTTP 429 (which the keypool
 * SHOULD rotate on) and an error embedded in a 200 OK SSE stream (which the
 * keypool cannot detect). If "Rate limit exceeded" arrives via a 200 response
 * body, the keypool rotation will never fire — this wrapper reveals that case.
 * also print the Authorization header (with key hint) for each request to see which key was used.
 */
function installDebugFetch(): void {
  const level = process.env.BACKPORT_HTTP_DEBUG
  if (!level || level === "false") return

  const originalFetch = globalThis.fetch
  globalThis.fetch = async function debugFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input)
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    // Strip query params that may contain credentials before logging.
    const safeUrl = url.replace(/[?#].*$/, "")

    const response = await originalFetch(input, init)

    if (!response.ok) {
      // Non-2xx: always log status + first 400 chars of body.
      const body = await response.clone().text().catch(() => "(binary/unreadable)")
      process.stderr.write(
        `[HTTP] ← ${response.status} ${response.statusText} | ${method} ...${safeUrl.slice(-100)}\n` +
        `[HTTP]   ${body.slice(0, 400)}\n` + `[HTTP]   Authorization: ${maskApiKey(extractApiKeyFromAuthorizationHeader(init?.headers instanceof Headers ? init.headers.get("Authorization") : null) ?? "(none)")}\n`,
      )
    } else if (level === "verbose") {
      // Verbose mode: also log successful requests (no body, to avoid stream consumption).
      let authHeader: string | null = null
      let userAgent: string | null = null
      let modelName: string | null = null

      if (init?.headers instanceof Headers) {
        authHeader = init.headers.get("Authorization") || init.headers.get("authorization")
        userAgent = init.headers.get("User-Agent") || init.headers.get("user-agent")
      } else if (typeof init?.headers === 'object' && init.headers !== null) {
        const headers = init.headers as Record<string, string>
        authHeader = headers["Authorization"] || headers["authorization"] || null
        userAgent = headers["User-Agent"] || headers["user-agent"] || null
      }

      // Extract model from request body (OpenAI compatible format)
      try {
        if (init?.body) {
          const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
          const bodyObj = typeof body === 'string' ? JSON.parse(body) : body
          if (bodyObj?.model) {
            modelName = bodyObj.model
          }
        }
      } catch (error) {
        // Silently fail if body parsing fails
        modelName = null
      }

      const tokenCount = init?.body ? estimateTokens(typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : 0

      const apiKey = extractApiKeyFromAuthorizationHeader(authHeader)
      const apiKeyDisplay = apiKey ? maskApiKey(apiKey) : "(none)"
      const userAgentDisplay = userAgent || "(none)"
      const modelDisplay = modelName || "(none)"

      process.stderr.write(
        `[HTTP] ← 200 ${response.statusText} | ${method} ...${safeUrl.slice(-100)}\n` +
        `[HTTP] API Key: ${apiKeyDisplay}\n` +
        `[HTTP] User-Agent: ${userAgentDisplay}\n` +
        `[HTTP] Model: ${modelDisplay}\n` +
        `[HTTP] Estimated tokens in request body: ${tokenCount}\n`
      )
    }

    return response
  }

  process.stderr.write(`[HTTP] Debug fetch wrapper active (BACKPORT_HTTP_DEBUG=${level})\n`)
}

export async function setupAgent(params: AgentSetupParams): Promise<AgentSetupResult> {
  const { config, promptLogPath, verbose } = params

  // Install HTTP debug wrapper early so it covers all requests made by the SDK.
  installDebugFetch()

  // --- Customization loading ---
  const customizations = await loadCustomizations(
    config.customizations ?? process.env.BACKPORT_CUSTOMIZATIONS,
  )

  // --- User instruction service setup ---
  const userInstructionService = createUserInstructionConfigService({
    skills: { workspacePath: config.workingDir },
  })

  await userInstructionService.start()

  // --- Tool assembly ---
  // Each factory returns one or more AgentTool instances bound to the config.
  const gitTools = makeGitTools(config)                 // 10 tools for git operations
  const riskTool = makeRiskTool(config, customizations) // 1 tool for risk classification
  const validationTool = makeValidationTool(config)     // 1 tool for validation suite
  const githubTools = makeGitHubTools(config)           // 3 tools for GitHub PR management
  // Pass handleKeypoolEvent so sub-agents (ai-tools, report-tools) have their
  // token usage tracked in keypoolStats — otherwise only the main agent's calls
  // appear in the detailed key usage report.
  const keypoolHandler = config.models.provider === "keypoollive" ? handleKeypoolEvent : undefined
  const reportTool = makeReportTool(config, promptLogPath, config.models.provider, resolveApiKey(config), keypoolHandler) // 1 terminal tool (completesRun: true)
  const aiTools = makeAiTools(config, promptLogPath, config.models.provider, resolveApiKey(config), customizations, keypoolHandler) // 4 AI-powered analysis tools

  // --- SDK built-in tools ---
  const builtinTools = createBuiltinTools({
    cwd: config.workingDir,
    enableReadFiles: true,
    enableSearch: true,
    enableBash: true,
    enableWebFetch: true,
    enableApplyPatch: true,
    enableEditor: true,
    enableSkills: true,
    enableAskQuestion: true,
    enableSubmitAndExit: true,
    executors: {
      // Resolve skills from the workspace through the SDK's user-instruction service.
      skills: async (skill: string, args: string | undefined) => {
        const configuredSkills = userInstructionService.listRecords("skill")
        const match = configuredSkills.find(
          (record: UserInstructionConfigRecord) => record.id === skill || record.item.name === skill || record.filePath === skill,
        )

        if (!match || match.item.disabled) {
          const availableSkills = configuredSkills
            .filter((record: UserInstructionConfigRecord) => !record.item.disabled)
            .map((record: UserInstructionConfigRecord) => record.item.name)

          return availableSkills.length > 0
            ? `Skill "${skill}" is not available. Known skills: ${availableSkills.join(", ")}`
            : `No configured skills are available in this backport-agent runtime.`
        }

        const parts = [
          `Skill: ${match.item.name}`,
          match.item.description ? `Description: ${match.item.description}` : null,
          args ? `Arguments: ${args}` : null,
          "Instructions:",
          match.item.instructions,
        ].filter(Boolean)

        return parts.join("\n")
      },
      // Headless CI mode: ask_question is surfaced but should not block runs.
      askQuestion: async (question: string, options: string[]) => {
        const normalizedOptions = options.length > 0 ? options.join(" | ") : "(no options)"
        return `Question recorded (headless mode): ${question} [${normalizedOptions}]`
      },
      // Keep submit_and_exit functional for compatibility with integrated flows.
      // Return JSON in the same shape as generate_report so main.ts can parse it uniformly.
      submit: async (summary: string, verified: boolean) =>
        JSON.stringify({ report: summary, allPassed: verified, needsHumanReview: !verified, agentState: {} }),
    },
  })

  // Flatten all tools into a single array for the Agent constructor.
  const allTools = [...builtinTools, ...gitTools, riskTool, validationTool, ...githubTools, reportTool, ...aiTools]

  // --- Keypool event handler (keypoollive provider only) ---
  // Provides real-time visibility into key selection, rotation, and token usage.
  // Accumulated statistics are printed as a summary at the end of the run.
  const keypoolStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    rotations: 0,
    exhaustions: 0,
    keysUsed: new Set<KeyUsage>(),
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
  }

  // Infer KeypoolEvent type from Agent constructor to avoid a direct import from @sctg/cline-shared.
  type AgentKeypoolEvent = NonNullable<Parameters<typeof Agent>[0]> extends { keypoolEventHandler?: (e: infer E) => void } ? E : never

  function handleKeypoolEvent(event: AgentKeypoolEvent): void {
    switch (event.type) {
      case "user-agent-set":
        process.stderr.write(
          `[Keypool] User-Agent: ${event.userAgent} (source: ${event.source})\n`,
        )
        break
      case "key-selected":
        process.stderr.write(
          `[Keypool] Key selected: ${event.keyHint}` +
          (event.keyOwner ? ` (${event.keyOwner})` : "") +
          ` — ${event.providerName}/${event.modelId}\n`,
        )
        keypoolStats.keysUsed.add({ event: event.type, owner: event.keyOwner ?? "(unknown)", keyHint: event.keyHint, modelId: event.modelId })
        break
      case "key-rotated":
        keypoolStats.rotations++
        process.stderr.write(
          `[Keypool] Rotating from ${event.failedKeyHint}` +
          ` (attempt ${event.attempt + 1}): ${event.error.slice(0, 120)}\n`,
        )
        break
      case "key-exhausted":
        keypoolStats.exhaustions++
        process.stderr.write(
          `[Keypool] All ${event.attempts} rotation attempts exhausted` +
          ` for ${event.providerName}/${event.modelId}\n`,
        )
        break
      case "key-recovered":
        if (verbose) {
          process.stderr.write(`[Keypool] Key healthy: ${event.keyHint}\n`)
        }
        break
      case "usage-recorded":
        keypoolStats.totalInputTokens += event.inputTokens
        keypoolStats.totalOutputTokens += event.outputTokens
        keypoolStats.totalCacheReadTokens += event.cacheReadTokens
        keypoolStats.totalCacheWriteTokens += event.cacheWriteTokens
        keypoolStats.keysUsed.add({ event: event.type, owner: event.keyOwner ?? "(unknown)", keyHint: event.keyHint, modelId: event.modelId, usage: { input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens } })
        keypoolStats.lastInputTokens = event.inputTokens
        keypoolStats.lastCacheReadTokens = event.cacheReadTokens
        // Warn when the main orchestrator context approaches saturation.
        // Track total context (billed input + cache-read) because cached tokens
        // still occupy the context window and count toward the model limit.
        const totalContext = event.inputTokens + event.cacheReadTokens
        if (totalContext > 150_000) {
          process.stderr.write(
            `[Context] WARNING: ~${Math.round(totalContext / 1000)}k tokens in context` +
            ` (${Math.round(event.inputTokens / 1000)}k new + ${Math.round(event.cacheReadTokens / 1000)}k cached,` +
            ` model limit ~262k) — consider lowering maxCommitsPerRun\n`,
          )
        }
        if (verbose) {
          process.stderr.write(
            `[Keypool] Usage: in=${event.inputTokens} out=${event.outputTokens}` +
            (event.cacheReadTokens ? ` cacheRead=${event.cacheReadTokens}` : "") +
            ` via ${event.keyHint}` +
            (event.keyOwner ? ` (${event.keyOwner})` : "") + "\n",
          )
        }
        break
    }
  }

  // --- Agent factory ---
  // Returns a fresh Agent instance for each retry attempt so that conversation
  // history does not accumulate across retries (run() and continue() share the
  // same execute() in this SDK — a new instance guarantees a clean context).
  function agentFactory(): Agent {
    // Soft limit: inject a wrap-up message once when context approaches the model limit.
    const softLimit = config.sync.maxContextTokens
    // Hard limit: abort just before the API call would overflow the model's context window.
    // Capped at 260k to stay safely below devstral-medium-latest's 262k limit.
    const hardLimit = Math.min(Math.floor(softLimit * 1.15), 260_000)

    // Per-instance flag: only inject the wrap-up message once per agent run.
    let contextWrapupSent = false

    return new Agent({
      providerId: config.models.provider,
      modelId: config.models.fast,
      apiKey: resolveApiKey(config),
      systemPrompt: buildSystemPrompt((config.validation.final ?? []).length > 0),
      tools: allTools,
      maxIterations: config.sync.maxIterations,
      // Prevent the run from ending until generate_report (completesRun: true) is called.
      completionPolicy: { requireCompletionTool: true },
      // Wire keypoollive event callbacks to get visibility into key rotation and usage.
      ...(config.models.provider === "keypoollive" ? { keypoolEventHandler: handleKeypoolEvent } : {}),
      // Soft context guard: inject a one-time "wrap up NOW" user message when the previous
      // model call consumed more than softLimit tokens.  Track total context (billed input +
      // cache-read) because cached tokens still occupy the context window.
      consumePendingUserMessage: () => {
        const tokens = keypoolStats.lastInputTokens + keypoolStats.lastCacheReadTokens
        if (tokens >= softLimit && !contextWrapupSent) {
          contextWrapupSent = true
          process.stderr.write(
            `[Context] Soft limit reached (~${Math.round(tokens / 1000)}k tokens), injecting wrap-up signal\n`,
          )
          return (
            `[CONTEXT BUDGET EXCEEDED — ~${Math.round(tokens / 1000)}k / ${Math.round(softLimit / 1000)}k tokens consumed]\n` +
            `MANDATORY: Stop processing commits immediately.\n` +
            `Add ALL commits not yet cherry-picked to blockedCommits with reason "context-limit: deferred to next run".\n` +
            `Call generate_report NOW with every commit processed so far.\n` +
            `This is an automated safeguard — the run will be hard-aborted if generate_report is not called within the next iteration.`
          )
        }
        return undefined
      },
      // Hard context guard: abort before the API call when the context has already grown past
      // the hard limit.  The abort reason matches CONTEXT_OVERFLOW_RE in retry-logic.ts so
      // it is treated as non-retriable (retrying would only recreate the same overflow).
      hooks: {
        beforeModel: async () => {
          const tokens = keypoolStats.lastInputTokens + keypoolStats.lastCacheReadTokens
          if (tokens >= hardLimit) {
            process.stderr.write(
              `[Context] Hard limit reached (~${Math.round(tokens / 1000)}k tokens ≥ ${Math.round(hardLimit / 1000)}k), aborting run to prevent context window overflow\n`,
            )
            return {
              stop: true,
              reason: `Context window limit reached: ~${Math.round(tokens / 1000)}k tokens exceeds the ${Math.round(hardLimit / 1000)}k hard limit — generate_report was not called in time, aborting run`,
            }
          }
          return undefined
        },
      },
      // Context compaction: when the conversation history exceeds compactionThreshold, use a
      // large-context summarizer model (e.g. Gemini 2.5 Flash, 1M tokens) to distil the
      // transcript into a compact progress summary.  The replacement persists permanently in
      // the in-memory transcript (unlike beforeModel which applies for one turn only), so the
      // agent continues processing remaining commits with a fresh ~15k context budget.
      prepareTurn: async ({ messages, systemPrompt }: PrepareTurnContext) => {
        const tokens = keypoolStats.lastInputTokens + keypoolStats.lastCacheReadTokens
        if (tokens < config.sync.compactionThreshold) return undefined

        const { providerId: sProvider, modelId: sModel, apiKey: sKey } = getSummarizerConfig(config)
        process.stderr.write(
          `[Context] Compacting ~${Math.round(tokens / 1000)}k tokens via ${sProvider}/${sModel}...\n`,
        )
        const compacted = await compactConversation(messages, systemPrompt ?? "", config, sProvider, sKey)
        if (!compacted) {
          process.stderr.write(`[Context] Compaction failed — soft/hard limits remain as fallback\n`)
          return undefined
        }
        process.stderr.write(`[Context] Compaction done: ${messages.length} → ${compacted.length} messages\n`)
        // Reset stale per-call token stats so beforeModel doesn't abort based on pre-compaction
        // values. The next model call will record fresh stats via the keypool "usage-recorded" event.
        keypoolStats.lastInputTokens = 0
        keypoolStats.lastCacheReadTokens = 0
        return { messages: compacted }
      },
    })
  }

  return {
    agentFactory,
    userInstructionService,
    keypoolStats
  }
}
```

### `src/agent/context-compaction.ts`

**Exports:** serializeMessages, getSummarizerConfig, compactConversation

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file agent/context-compaction.ts
 *
 * Automatic context compaction for the Backport Agent.
 *
 * When the agent's conversation history approaches the model's context limit,
 * the `prepareTurn` hook in agent-setup.ts calls `compactConversation()` here.
 * A large-context summarizer model (e.g. Gemini 2.5 Flash, 1M tokens) distils
 * the full transcript into a compact progress summary, resetting the in-context
 * history to ~15k tokens so the run can continue processing remaining commits.
 *
 * The summarizer returns structured JSON:
 *   { progressSummary, commitResults, blockedCommits, currentStep }
 *
 * These fields are injected back as synthetic assistant context before the
 * last few messages (recency window), giving the main model enough context to
 * resume where it left off without any awareness that compaction occurred.
 */

import { randomUUID } from "node:crypto"
import { Agent } from "@sctg/cline-sdk"
import type { AgentMessage, AgentMessagePart } from "@sctg/cline-agents"
import type { SyncConfig } from "../config/schema.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CompactionSummary {
  progressSummary: string
  commitResults: unknown[]
  blockedCommits: unknown[]
  currentStep: string
}

interface SummarizerConfig {
  providerId: string
  modelId: string
  apiKey: string | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Construct a minimal but valid AgentMessage for injecting synthetic context.
 */
function makeTextMessage(role: "user" | "assistant", text: string): AgentMessage {
  return {
    id: randomUUID(),
    role,
    content: [{ type: "text", text }],
    createdAt: Date.now(),
  }
}

/**
 * Serialise an AgentMessage array into a human-readable conversation transcript.
 * This is what the summarizer receives to understand the full run history.
 *
 * - user / assistant roles: render text and reasoning parts; tool-call and
 *   tool-result parts are summarised as one-liners to avoid inflating the
 *   serialised size with large JSON outputs.
 * - tool role: render as [TOOL RESULT] one-liner.
 */
export function serializeMessages(messages: readonly AgentMessage[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    const roleLabel = msg.role === "user" ? "[USER]" : msg.role === "assistant" ? "[ASSISTANT]" : "[TOOL]"

    for (const part of msg.content) {
      switch (part.type) {
        case "text":
          lines.push(`${roleLabel}: ${part.text}`)
          break
        case "reasoning":
          lines.push(`${roleLabel} [REASONING]: ${part.text}`)
          break
        case "tool-call": {
          const inputStr = typeof part.input === "string" ? part.input : JSON.stringify(part.input)
          // Truncate large inputs so the transcript stays manageable.
          const truncated = inputStr.length > 500 ? inputStr.slice(0, 500) + "…" : inputStr
          lines.push(`${roleLabel} [TOOL CALL: ${part.toolName}]: ${truncated}`)
          break
        }
        case "tool-result": {
          const outputStr = typeof part.output === "string" ? part.output : JSON.stringify(part.output)
          const truncated = outputStr.length > 800 ? outputStr.slice(0, 800) + "…" : outputStr
          lines.push(`${roleLabel} [TOOL RESULT: ${part.toolName}]: ${truncated}`)
          break
        }
        default:
          // image / file / unknown parts: skip silently
          break
      }
    }
  }

  return lines.join("\n\n")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the provider/model/key to use for compaction.
 * Falls back to `models.specialist` with the same provider if `models.summarizer` is absent.
 */
export function getSummarizerConfig(config: SyncConfig): SummarizerConfig {
  if (config.models.summarizer) {
    const { provider, modelId, apiKey } = config.models.summarizer
    // If apiKey is an env-var reference (starts with "$"), resolve it.
    const resolvedKey = apiKey?.startsWith("$") ? process.env[apiKey.slice(1)] : apiKey
    return { providerId: provider, modelId, apiKey: resolvedKey }
  }
  // Fallback: use specialist model with the same provider and API key as the main agent.
  // Note: the main API key is accessed via config; provider.ts resolution happens upstream.
  const fallbackKey = config.models.apiKey === "auto"
    ? undefined
    : config.models.apiKey?.startsWith("$")
      ? process.env[config.models.apiKey.slice(1)]
      : config.models.apiKey
  return {
    providerId: config.models.provider,
    modelId: config.models.specialist,
    apiKey: fallbackKey,
  }
}

/**
 * Compact the agent's conversation history using a large-context summarizer model.
 *
 * @param messages    - Current conversation messages from `prepareTurn`.
 * @param systemPrompt - The agent's system prompt (preserved verbatim in output).
 * @param config      - Validated SyncConfig (for summarizer model resolution).
 * @param providerId  - Resolved provider ID for the summarizer.
 * @param apiKey      - Resolved API key for the summarizer.
 * @returns Compacted messages array, or `null` on any failure (triggering soft/hard fallbacks).
 */
export async function compactConversation(
  messages: readonly AgentMessage[],
  _systemPrompt: string,
  config: SyncConfig,
  providerId: string,
  apiKey: string | undefined,
): Promise<readonly AgentMessage[] | null> {
  const { modelId } = getSummarizerConfig(config)

  // Need at least a few messages for compaction to be worthwhile.
  if (messages.length < 4) return null

  // Identify the original task (first user message) — preserved verbatim.
  const firstUserMsg = messages.find((m) => m.role === "user")
  const originalTask = firstUserMsg
    ? firstUserMsg.content
        .filter((p: AgentMessagePart) => p.type === "text")
        .map((p: AgentMessagePart) => (p as { type: "text"; text: string }).text)
        .join("\n")
    : "(original task unavailable)"

  // Keep the last 6 messages verbatim as a recency window so the model knows
  // exactly what step it was on when compaction fired.
  const recentMessages = messages.slice(-6)

  // Serialize the full conversation for the summarizer.
  const transcript = serializeMessages(messages)

  const summarizerSystemPrompt = `You are summarizing the progress of an ongoing automated git backport-agent run.
Your output will be used to resume the run after its context was compacted.

You MUST return ONLY a JSON object with exactly these fields (no markdown, no explanation):
{
  "progressSummary": "<markdown summary of all work done>",
  "commitResults": [<complete array of all commit decisions>],
  "blockedCommits": [<complete array of blocked/deferred commits>],
  "currentStep": "<what the agent was about to do next>"
}

Rules:
- Preserve ALL commit SHAs exactly — they are needed to resume the run
- Each entry in commitResults must include: sha, subject, riskLevel, result (applied/skipped/conflict-blocked/validation-failed), and any reason
- Each entry in blockedCommits must include: sha, subject, reason
- currentStep must be actionable (e.g. "cherry-pick commit abc1234" or "call run_validation after applying 3 commits")
- progressSummary should be 3–8 bullet points covering what was accomplished`

  const userPrompt = `Here is the complete conversation transcript to summarize:\n\n${transcript}`

  try {
    const summarizer = new Agent({
      providerId,
      modelId,
      apiKey,
      systemPrompt: summarizerSystemPrompt,
      tools: [],
    })

    const result = await summarizer.run(userPrompt)

    if (result.status !== "completed" || !result.outputText) {
      process.stderr.write(`[Compaction] Summarizer ended with status "${result.status}" — skipping compaction\n`)
      return null
    }

    // Strip markdown code fences if the model wrapped JSON in them.
    const rawJson = result.outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")

    let summary: CompactionSummary
    try {
      summary = JSON.parse(rawJson) as CompactionSummary
    } catch {
      process.stderr.write(`[Compaction] Failed to parse summarizer JSON — skipping compaction\n`)
      return null
    }

    // Validate the required fields exist.
    if (typeof summary.progressSummary !== "string" || !Array.isArray(summary.commitResults)) {
      process.stderr.write(`[Compaction] Summarizer returned incomplete JSON — skipping compaction\n`)
      return null
    }

    // Build the compacted messages array:
    // 1. Original task (user)
    // 2. Compact progress summary (assistant)
    // 3. Last 6 messages verbatim (recency window)
    const summaryContent = [
      "=== CONTEXT COMPACTED ===",
      "",
      summary.progressSummary,
      "",
      `**commitResults (${summary.commitResults.length} entries):**`,
      "```json",
      JSON.stringify(summary.commitResults, null, 2),
      "```",
      "",
      `**blockedCommits (${summary.blockedCommits.length} entries):**`,
      "```json",
      JSON.stringify(summary.blockedCommits, null, 2),
      "```",
      "",
      `**Current step:** ${summary.currentStep}`,
      "",
      "Resume from this step. The conversation history above has been summarised to free context space.",
    ].join("\n")

    const compacted: AgentMessage[] = [
      makeTextMessage("user", originalTask),
      makeTextMessage("assistant", summaryContent),
      ...recentMessages,
    ]

    return compacted
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[Compaction] Summarizer error: ${msg.slice(0, 200)} — skipping compaction\n`)
    return null
  }
}
```

### `src/agent/event-handlers.ts`

**Exports:** setupEventHandlers, EventHandlers

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file event-handlers.ts
 *
 * Event handlers for the Backport Agent.
 * Handles agent event subscription and output streaming.
 */
import type { Agent } from "@sctg/cline-sdk"

interface EventHandlersParams {
  verbose: boolean
}

interface EventHandlersResult {
  subscribeToAgent: (agent: Agent) => void
  getLastSeenIteration: () => number
  /** Returns maxIterationFromPreviousRuns + lastSeenIteration (the effective displayed iteration). */
  getLastDisplayedIteration: () => number
  resetIterationTracking: () => void
  updateMaxIterationFromPreviousRuns: (value: number) => void
  updateCurrentAttempt: (value: number) => void
}

export function setupEventHandlers(params: EventHandlersParams): EventHandlersResult {
  const { verbose } = params

  // --- Shared iteration state ---
  // Track iterations across retry attempts: when restarting after an error,
  // display should show the max iteration seen before the retry (not cumulative).
  let lastEventWasText = false
  let maxIterationFromPreviousRuns = 0
  let lastSeenIteration = 0
  let currentAttempt = 1

  // Subscribe a fresh Agent instance to the shared streaming handlers.
  // Called once per retry attempt since each attempt creates a new Agent.
  function subscribeToAgent(agent: Agent): void {
    agent.subscribe((event: Parameters<Parameters<typeof agent.subscribe>[0]>[0]) => {
      const rawIter = (event as unknown as { iteration?: number }).iteration
      if (typeof rawIter === "number" && rawIter > lastSeenIteration) {
        lastSeenIteration = rawIter
      }
      const displayIter = typeof rawIter === "number" ? maxIterationFromPreviousRuns + rawIter : "?"
      if (event.type === "assistant-text-delta") {
        lastEventWasText = true
        process.stdout.write(event.text)
      } else if (event.type === "tool-started" && verbose) {
        if (lastEventWasText) process.stderr.write("\n")
        lastEventWasText = false
        const inp = event.toolCall.input as Record<string, unknown>
        const preview =
          inp && typeof inp === "object" && Object.keys(inp).length > 0
            ? Object.keys(inp)
                .slice(0, 2)
                .map((k) => `${k}=${JSON.stringify(inp[k]).slice(0, 60)}`)
                .join(", ")
            : "(no input)"
        process.stderr.write(`[→ iter ${displayIter}] ${event.toolCall.toolName}(${preview})\n`)
      } else if (event.type === "tool-finished" && verbose) {
        lastEventWasText = false
        const result = event.toolCall as unknown as { toolName: string }
        process.stderr.write(`[← iter ${displayIter}] ${result.toolName ?? event.toolCall.toolName} done\n`)
      } else if ((event.type === "iteration_start" || event.type === "turn-started") && verbose) {
        const retrySuffix = currentAttempt > 1 ? ` - Retry ${currentAttempt - 1}` : ""
        process.stderr.write(`\n--- iteration ${displayIter}${retrySuffix} ---\n`)
      }
    })
  }

  return {
    subscribeToAgent,
    getLastSeenIteration: () => lastSeenIteration,
    getLastDisplayedIteration: () => maxIterationFromPreviousRuns + lastSeenIteration,
    resetIterationTracking: () => {
      currentAttempt = 1
      lastSeenIteration = 0
      maxIterationFromPreviousRuns = 0
    },
    updateMaxIterationFromPreviousRuns: (value: number) => {
      maxIterationFromPreviousRuns = value
      // Reset the raw-iter tracker so the next run can accumulate from 1.
      // Without this, SDK iters 1, 2, ... from the resumed run would be < the
      // previous max (e.g. 14) and lastSeenIteration would never update.
      lastSeenIteration = 0
    },
    updateCurrentAttempt: (value: number) => {
      currentAttempt = value
    },
  }
}

export type EventHandlers = ReturnType<typeof setupEventHandlers>
```

### `src/agent/retry-logic.ts`

**Exports:** runWithRetry

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file retry-logic.ts
 *
 * Retry logic for provider errors in the Backport Agent.
 * Handles exponential backoff and retry attempts for rate limits and timeouts.
 */
import type { Agent } from "@sctg/cline-sdk"

interface RetryLogicParams {
  agentFactory: () => Agent
  task: string
  eventHandlers: {
    subscribeToAgent: (agent: Agent) => void
    getLastSeenIteration: () => number
    getLastDisplayedIteration: () => number
    resetIterationTracking: () => void
    updateMaxIterationFromPreviousRuns: (value: number) => void
    updateCurrentAttempt: (value: number) => void
  }
  /** Returns the input token count of the last successful LLM call (0 before first call). */
  getLastInputTokens: () => number
}

export async function runWithRetry(params: RetryLogicParams): Promise<Awaited<ReturnType<typeof Agent.prototype.run>>> {
  const { agentFactory, task, eventHandlers, getLastInputTokens } = params

  const RETRIABLE_RE = /503|rate.?limit|too many requests|overloaded|service.?unavailable|high.?demand|try again later|temporarily unavailable|exceeded your current quota|quota.*exceeded|check your plan|billing details/i
  const TIMEOUT_RE = /timeout|timed out|body timeout|request timeout|socket timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|deadline exceeded|response timeout|read timeout|connect timeout/i
  // Context overflow errors must NOT be retried — retrying would only accumulate more history.
  const CONTEXT_OVERFLOW_RE = /too large for model|maximum context|context.?length|context.?window|token limit|exceeds.*context/i
  const BASE_DELAY_MS = 15_000
  const MAX_ATTEMPTS = 5

  // Message sent on transient-error retries. The agent sees its full conversation
  // history above this message and is explicitly told to resume rather than restart.
  // Re-injecting the original task would cause the model to restart from fetch_remotes,
  // discarding all work done before the interruption.
  const RESUME_MESSAGE =
    "A rate limit or temporary service error interrupted the previous attempt.\n" +
    "Your conversation history above shows all work completed so far.\n" +
    "IMPORTANT: Do NOT restart from fetch_remotes or list_candidate_commits.\n" +
    "Resume from exactly where you stopped — continue with the next pending step."

  // Writes a debug snapshot to the current working directory on retry.
  // Takes a context object so it can be called from both the throw-path (where
  // `result` is undefined) and the status-failed path (where `result` is set).
  async function writeDebugState(info: {
    attempt: number
    lastIteration: number
    lastInputTokens: number
    error: string
    result?: unknown
  }): Promise<void> {
    const fs = await import("fs/promises")
    const path = await import("path")
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const debugFile = path.join(process.cwd(), `agent-debug-${timestamp}.json`)
    await fs.writeFile(debugFile, JSON.stringify(info, null, 2), "utf-8")
    process.stderr.write(`[Retry] Debug state written to ${debugFile}\n`)
  }



  async function attempt(): Promise<Awaited<ReturnType<typeof Agent.prototype.run>>> {
    // currentAgent is kept alive across transient-error retries so the model can
    // resume its conversation from the last completed iteration. A fresh agent is
    // only created on the first attempt.
    let currentAgent: Agent | null = null

    for (let attemptNum = 1; attemptNum <= MAX_ATTEMPTS; attemptNum++) {
      eventHandlers.updateCurrentAttempt(attemptNum)

      // First attempt: fresh agent with the full task description.
      // Subsequent transient-error retries: reuse the same agent and send a resume
      // message so the model continues from its last iteration without restarting.
      let agent: Agent
      let message: string
      if (currentAgent === null) {
        agent = agentFactory()
        eventHandlers.subscribeToAgent(agent)
        currentAgent = agent
        message = task
      } else {
        agent = currentAgent
        message = RESUME_MESSAGE
      }

      let result: Awaited<ReturnType<typeof Agent.prototype.run>>
      try {
        result = await agent.run(message)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)

        // Context overflow is never retriable — it would only grow worse.
        if (CONTEXT_OVERFLOW_RE.test(msg)) {
          process.stderr.write(
            `[Retry] Context overflow on attempt ${attemptNum}/${MAX_ATTEMPTS}: ${msg.slice(0, 200)}\n` +
              `[Retry] This is not retriable. Lower maxCommitsPerRun or reduce diff sizes.\n`,
          )
          throw err
        }

        if (attemptNum < MAX_ATTEMPTS && (RETRIABLE_RE.test(msg) || TIMEOUT_RE.test(msg))) {
          const base = BASE_DELAY_MS * Math.pow(2, attemptNum - 1)
          const jitter = Math.floor(Math.random() * 0.3 * base)
          const delay = Math.min(base + jitter, 120_000)
          const errorType = TIMEOUT_RE.test(msg) ? "Timeout" : "Provider"
          const lastTokens = getLastInputTokens()

          process.stderr.write(
            `[Retry] ${errorType} error on attempt ${attemptNum}/${MAX_ATTEMPTS}: ${msg.slice(0, 120)}\n` +
              `[Retry] Last known context: ~${Math.round(lastTokens / 1000)}k tokens` +
              ` (iter ${eventHandlers.getLastDisplayedIteration()})\n` +
              `[Retry] Waiting ${Math.round(delay / 1000)}s before retrying (agent state preserved)...\n`,
          )
          writeDebugState({
            attempt: attemptNum,
            lastIteration: eventHandlers.getLastDisplayedIteration(),
            lastInputTokens: lastTokens,
            error: msg,
          }).catch((e: unknown) => {
            process.stderr.write(`[Retry] Failed to write debug state: ${e}\n`)
          })
          // The SDK resets its internal iteration counter to 1 with each run() call.
          // Update the display offset so resumed iterations continue from where they stopped.
          eventHandlers.updateMaxIterationFromPreviousRuns(eventHandlers.getLastDisplayedIteration())
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw err
      }

      // The SDK can return without throwing when the model API errors silently
      // (e.g. invalid model name, 503 absorbed internally). Treat non-completed
      // status as a throw so the retry loop can handle retriable cases.
      if (result.status !== "completed") {
        const err = result.error ?? new Error(`Agent run ended with status "${result.status}" (model API error?)`)
        const msg = err.message

        if (CONTEXT_OVERFLOW_RE.test(msg)) {
          process.stderr.write(
            `[Retry] Context overflow (status=${result.status}): ${msg.slice(0, 200)}\n` +
              `[Retry] This is not retriable. Lower maxCommitsPerRun or reduce diff sizes.\n`,
          )
          writeDebugState({
            attempt: attemptNum,
            lastIteration: eventHandlers.getLastDisplayedIteration(),
            lastInputTokens: getLastInputTokens(),
            error: msg,
            result,
          }).catch((e: unknown) => {
            process.stderr.write(`[Retry] Failed to write debug state: ${e}\n`)
          })
          throw err
        }

        if (attemptNum < MAX_ATTEMPTS && (RETRIABLE_RE.test(msg) || TIMEOUT_RE.test(msg))) {
          const base = BASE_DELAY_MS * Math.pow(2, attemptNum - 1)
          const jitter = Math.floor(Math.random() * 0.3 * base)
          const delay = Math.min(base + jitter, 120_000)
          const errorType = TIMEOUT_RE.test(msg) ? "Timeout" : "Provider"
          const lastTokens = getLastInputTokens()

          process.stderr.write(
            `[Retry] ${errorType} error (status=${result.status}) on attempt ${attemptNum}/${MAX_ATTEMPTS}: ${msg.slice(0, 120)}\n` +
              `[Retry] Last known context: ~${Math.round(lastTokens / 1000)}k tokens` +
              ` (iter ${eventHandlers.getLastDisplayedIteration()})\n` +
              `[Retry] Waiting ${Math.round(delay / 1000)}s before retrying (agent state preserved)...\n`,
          )
          writeDebugState({
            attempt: attemptNum,
            lastIteration: eventHandlers.getLastDisplayedIteration(),
            lastInputTokens: lastTokens,
            error: msg,
            result,
          }).catch((e: unknown) => {
            process.stderr.write(`[Retry] Failed to write debug state: ${e}\n`)
          })
          eventHandlers.updateMaxIterationFromPreviousRuns(eventHandlers.getLastDisplayedIteration())
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw err
      }

      eventHandlers.resetIterationTracking()
      return result
    }
    throw new Error("unreachable")
  }

  return attempt()
}
```

### `src/agent/system-prompt.ts`

**Exports:** buildSystemPrompt, SYSTEM_PROMPT

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file system-prompt.ts
 *
 * System prompt builder for the Backport Agent.
 * Generates the system prompt with optional sections based on config.
 */

/**
 * Builds the system prompt for the agent.
 *
 * @param hasFinalValidation - Whether `config.validation.final` has at least one command.
 *   When true, step 6 includes an instruction to call `run_validation(riskLevel="final")`
 *   after all per-commit validation.
 */
export function buildSystemPrompt(hasFinalValidation: boolean): string {
  const finalValidationStep = hasFinalValidation
    ? "\n   - Once all per-commit work is done (step 6 above passed), call run_validation(riskLevel=\"final\") for a comprehensive end-to-end build check of the full repository."
    : ""

  return `You are the Backport Agent, a specialist in safely synchronizing a customized Git fork with its upstream repository.

## Your mission
Integrate upstream commits into the fork branch while preserving all fork-specific customizations.
Produce a draft pull request with a clear report. Never push directly to the main branch.

## Core workflow (follow this exactly)

1. Call fetch_remotes to ensure refs are up to date.
2. Call list_candidate_commits to get pending upstream commits (already filtered, newest-last).
   - Record all returned SHAs immediately. You are accountable for every single one.
3. For each candidate commit (process ALL of them — no silent skips):
   a. Call get_commit_details (with includeDiff: false) to get the changed file list.
      Do NOT request the diff here — AI tools fetch it internally to save context space.
   b. Call classify_commit_risk to determine risk level deterministically.
   c. Risk-based decision:
      - LOW risk: proceed directly to step 5 (cherry-pick). No AI analysis needed.
      - MEDIUM risk: call analyze_commit_for_backport (pass sha, commitMessage, changedFiles — no diff),
        then proceed to cherry-pick.
      - HIGH risk (touches a customization zone):
        * MANDATORY: Call check_customization_compatibility — pass sha and affected customization entries.
        * MANDATORY: Call analyze_commit_for_backport — pass sha, commitMessage, and changedFiles.
        * Read both responses carefully:
          - If both tools confirm the change is SAFE or ORTHOGONAL to the customization (e.g., it modifies a
            different provider, unrelated docs section, or infrastructure that doesn't overlap with fork code):
            → proceed to cherry-pick (step 5). Do NOT block on risk level alone.
          - If the tools identify a genuine semantic conflict (same code paths, incompatible invariants):
            → add to blockedCommits with a precise reason from the AI analysis.
          - If uncertain: still attempt the cherry-pick; conflicts will surface in step 5c.
   d. Commits with alreadyApplied: true → record as "skipped" in commitResults.
4. Create the sync branch via create_sync_branch (once, before first cherry-pick).
5. For each non-skipped commit (process lowest risk first):
   a. Call cherry_pick_commit.
   b. If success: record as "applied" in commitResults and proceed to next.
   c. If conflicts: for each conflicted file, call get_conflict_context, then attempt resolution.
      - Check the \`forcedStrategy\` field returned by get_conflict_context:
        * \`forcedStrategy: "ours"\`   → use \`forkVersion\` directly as resolvedContent; call apply_resolved_file immediately. No AI call needed.
        * \`forcedStrategy: "theirs"\` → use \`upstreamVersion\` directly as resolvedContent; call apply_resolved_file immediately. No AI call needed.
        * \`forcedStrategy: null\`     → proceed with AI resolution below.
      - (When forcedStrategy is null) Call resolve_conflict_with_ai with the base/ours/theirs content.
        * If classify_commit_risk returned non-empty customizationIds for this commit, pass them as
          \`affectedCustomizationIds\` so the model knows which fork invariants to preserve.
      - If confidence is "high" or "medium": verify no conflict markers remain, then call apply_resolved_file, then continue_cherry_pick.
      - If confidence is "low" or the tool returned an error: call abort_cherry_pick, mark commit as conflict-blocked.
6. Call run_validation with the highest risk level encountered in this run.
   - If classify_commit_risk returned non-empty \`testCommands\` for any commit in this run, pass them
     as \`extraCommands\` to run_validation so customization-specific tests are included in the suite.${finalValidationStep}
7. If validation fails: note it in the report, mark relevant commits as validation-failed.
8. Call push_sync_branch (unless dry-run).
9. Call find_existing_sync_pr to check for an existing PR.
10. Call generate_report with the full summary of all decisions.
11. Call create_sync_pr with the report as body (unless an existing PR was found and up to date).
12. If the task context line says "Auto-merge on success: enabled" AND all commits in this run were
    applied or skipped (none are conflict-blocked or validation-failed) AND run_validation returned
    allPassed:true, call auto_merge_pr(prNumber) with the PR number from step 11.

## Accountability (enforced — never skip)
- You received a finite list of SHAs from list_candidate_commits.
- EVERY SHA must appear in generate_report: either in commitResults (as applied/skipped/conflict-blocked/validation-failed) OR in blockedCommits.
- No commit may be silently dropped. If you are unsure what to do with a commit, add it to blockedCommits with reason "deferred: needs human triage".
- blockedCommits entries MUST include a specific human-readable reason (not just the SHA).
- Pass allCandidateShas to generate_report — it cross-checks accountability automatically.

## Hard constraints (never violate)
- NEVER block a commit solely because classify_commit_risk returns "high" — always run the mandatory AI tools first.
- NEVER apply a resolved file with conflict markers (<<<, ===, >>>) still present.
- NEVER call continue_cherry_pick before all conflicted files are staged.
- NEVER fabricate file content — only use content from get_conflict_context.
- NEVER run commands that are not available as tools.
- NEVER skip generate_report — it ends the run and produces the output.
`
}

/** @deprecated Use `buildSystemPrompt` instead. Kept for backward compatibility. */
export const SYSTEM_PROMPT = buildSystemPrompt(false)
```

### `src/ai/ai-tools.ts`

**Exports:** extractJson, checkSyntaxBalance, computeLineSimilarity, detectHallucinatedFileRefs, makeAiTools

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file ai/ai-tools.ts
 *
 * AI-powered agent tools that spawn focused sub-agents for tasks requiring
 * deep language model reasoning beyond what the deterministic rule engine
 * can provide.
 *
 * **Why sub-agents?**
 * The main backport agent drives the orchestration loop and calls deterministic
 * git/GitHub/validation tools.  Some decisions — conflict resolution, semantic
 * understanding of diffs, customisation compatibility — benefit from a dedicated
 * LLM call with a narrowly scoped system prompt and no distracting tool context.
 * Spawning a sub-`Agent` with `tools: []` gives exactly that: a single-turn
 * reasoning call that returns structured JSON.
 *
 * **Tools exported by `makeAiTools`:**
 *
 * 1. `resolve_conflict_with_ai` — Given a three-way conflict (base / ours /
 *    theirs), produce a resolved file body with no conflict markers.
 *    Uses `config.models.powerful` for maximum reasoning quality.
 *
 * 2. `analyze_commit_for_backport` — Given a commit SHA, message, diff, and
 *    changed-file list, produce a structured semantic assessment of what the
 *    commit does and how risky it is to backport.
 *    Uses `config.models.fast` (analytical but not critical-path).
 *
 * 3. `check_customization_compatibility` — Given a diff and a list of
 *    customisation records (pattern + description), reason about whether the
 *    upstream changes could semantically break fork-specific behaviour even
 *    if no textual conflict exists.
 *    Uses `config.models.fast`.
 *
 * **JSON extraction:**
 * Sub-agents are instructed to emit only a JSON object.  In practice, some
 * models wrap the object in a markdown code fence.  `extractJson` strips the
 * fence when present so `JSON.parse` always receives clean text.
 *
 * **Error handling:**
 * If the sub-agent call fails (network error, model error, parse error), each
 * tool returns a structured fallback object with `error` set rather than
 * throwing, so the main agent can log the failure and continue.
 */

import { z } from "zod"
import { Agent } from "@sctg/cline-sdk"
import { defineTool } from "../tool-helper.js"
import type { SyncConfig } from "../config/schema.js"
import type { Customizations } from "../customizations/schema.js"
import { getCommitDiff } from "../git/git-client.js"
import { globSync } from "node:fs"
import { join as joinPath } from "node:path"
import { minimatch } from "minimatch"

// Timeout error detection regex - matches common timeout error messages
const TIMEOUT_ERROR_PATTERNS = [
  /body timeout/i,
  /request timeout/i,
  /socket timeout/i,
  /ETIMEDOUT/i,
  /ESOCKETTIMEDOUT/i,
  /ECONNABORTED/i,
  /deadline exceeded/i,
  /response timeout/i,
  /read timeout/i,
  /connect timeout/i,
  /timed out/i,
  /timeout error/i,
  /timeout after/i,
  /timeout: /i,
  / timed out/i,
  / timeout /i,
]

/**
 * Checks if an error message indicates a timeout error
 * @param errorMessage - The error message to check
 * @returns true if the error is a timeout error, false otherwise
 */
function isTimeoutError(errorMessage: string): boolean {
  return TIMEOUT_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage))
}

/**
 * Logs a timeout error with enhanced verbosity
 * @param logPath - Path to the JSONL log file
 * @param toolName - Name of the tool that timed out
 * @param errorMessage - The timeout error message
 * @param context - Additional context about what was being processed
 */
function logTimeoutError(logPath: string, toolName: string, errorMessage: string, context: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const errorRecord = {
    type: "timeout_error",
    timestamp,
    tool: toolName,
    error: errorMessage,
    ...context
  }

  // Log to stderr with high visibility
  process.stderr.write(`\n[TIMEOUT ERROR] ${timestamp} - ${toolName}\n`)
  process.stderr.write(`[TIMEOUT ERROR] Error: ${errorMessage}\n`)
  if (context.sha) {
    process.stderr.write(`[TIMEOUT ERROR] Commit SHA: ${context.sha}\n`)
  }
  if (context.commitMessage) {
    const shortMessage = typeof context.commitMessage === 'string' ? context.commitMessage.slice(0, 100) : ''
    process.stderr.write(`[TIMEOUT ERROR] Commit: ${shortMessage}${shortMessage.length === 100 ? '...' : ''}\n`)
  }
  if (context.durationMs) {
    process.stderr.write(`[TIMEOUT ERROR] Duration: ${context.durationMs}ms\n`)
  }
  process.stderr.write(`[TIMEOUT ERROR] Tool: ${toolName}\n`)
  process.stderr.write('[TIMEOUT ERROR] See prompt log for full details\n')

  // Also log to the JSONL file for audit trail
  try {
    appendFileSync(logPath, JSON.stringify(errorRecord) + "\n", "utf8")
  } catch {
    process.stderr.write(`[TimeoutLogger] Warning: could not write timeout error to ${logPath}\n`)
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for AI tool output validation (Improvement 1)
// ---------------------------------------------------------------------------

/**
 * Expected shape of `resolve_conflict_with_ai` model output.
 * Validated at runtime so schema mismatches surface immediately instead of
 * silently propagating wrong types through the agent loop.
 */
const ConflictResolutionOutputSchema = z.object({
  resolvedContent: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
})
export { ConflictResolutionOutputSchema }

/** Expected shape of `analyze_commit_for_backport` model output. */
const AnalyzeCommitOutputSchema = z.object({
  summary: z.string().max(500),
  keyChanges: z.array(z.string().max(150)).max(5),
  backportComplexity: z.enum(["trivial", "moderate", "complex"]),
  semanticRiskFactors: z.array(z.string().max(200)).max(3),
  recommendation: z.enum(["apply", "apply-with-care", "review-required", "skip"]),
})
export { AnalyzeCommitOutputSchema }

/** Expected shape of `check_customization_compatibility` model output. */
const CheckCompatibilityOutputSchema = z.object({
  compatible: z.boolean(),
  affectedCustomizations: z.array(z.string().max(100)).max(5),
  semanticConflicts: z.array(z.string().max(200)).max(3),
  warnings: z.array(z.string().max(200)).max(3),
  recommendation: z.string().max(300),
})
export { CheckCompatibilityOutputSchema }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a JSON value from raw LLM output.
 *
 * The LLM may wrap its JSON in a markdown code fence (```` ```json … ``` ````
 * or ```` ``` … ``` ````).  This helper strips the fences when present so
 * `JSON.parse` receives valid JSON text.
 *
 * @typeParam T - Expected shape of the parsed value.
 * @param text - Raw string output from the sub-agent.
 * @returns The parsed value cast to `T`.
 * @throws `SyntaxError` if no valid JSON can be found in the text.
 */
export function extractJson<T>(text: string): T {
  // 1. Try ```json … ``` code fence (most common for structured output)
  const jsonFenceMatch = text.match(/```json\s*([\s\S]*?)```/)
  if (jsonFenceMatch) {
    return JSON.parse(jsonFenceMatch[1].trim()) as T
  }

  // 2. Try generic ``` … ``` code fence
  const genericFenceMatch = text.match(/```\s*([\s\S]*?)```/)
  if (genericFenceMatch) {
    return JSON.parse(genericFenceMatch[1].trim()) as T
  }

  // 3. Try to find an inline JSON object `{…}` in the text
  const inlineObjectMatch = text.match(/\{[\s\S]*\}/)
  if (inlineObjectMatch) {
    return JSON.parse(inlineObjectMatch[0]) as T
  }

  // 4. Last resort: parse the full trimmed text
  return JSON.parse(text.trim()) as T
}

// ---------------------------------------------------------------------------
// PromptLogger — records all sub-agent LLM interactions to a JSONL file
// ---------------------------------------------------------------------------

import { appendFileSync, readFileSync } from "node:fs"

/**
 * Token usage breakdown from a single sub-agent LLM call.
 */
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCost?: number
}

/**
 * Appends a single prompt/response record to the run's JSONL log file.
 *
 * The log file path is `./run-<timestamp>.prompts.jsonl` (relative to cwd).
 * It is created on first write and appended on subsequent calls.
 * Each line is a self-contained JSON object — suitable for streaming analysis
 * and incremental loading without parsing the entire file.
 *
 * @param logPath    - Absolute path to the JSONL log file for this run.
 * @param toolName   - The backport agent tool that invoked the sub-agent.
 * @param modelId    - LLM model identifier used for this call.
 * @param prompt     - Full user prompt sent to the sub-agent.
 * @param response   - Raw text response received from the sub-agent.
 * @param durationMs - Wall-clock time for the sub-agent call in milliseconds.
 * @param error      - Optional error message if the call failed.
 * @param usage      - Optional token usage breakdown from the LLM response.
 */
function logPrompt(
  logPath: string,
  toolName: string,
  modelId: string,
  prompt: string,
  response: string,
  durationMs: number,
  error?: string | null,
  usage?: TokenUsage | null,
  extra?: Record<string, unknown>,
): void {
  const record = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    model: modelId,
    durationMs,
    prompt,
    response,
    ...(error ? { error } : {}),
    ...(usage ? {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      ...(usage.totalCost != null ? { totalCost: usage.totalCost } : {}),
    } : {}),
    ...(extra ?? {}),
  }
  try {
    appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8")
  } catch {
    // Log write failures are non-fatal — the agent run must not be blocked.
    process.stderr.write(`[PromptLogger] Warning: could not write to ${logPath}\n`)
  }
}

// ---------------------------------------------------------------------------
// Audit event logger — independent trail not relying on LLM self-reporting
// (Improvement 9)
// ---------------------------------------------------------------------------

/**
 * Appends a structured audit event to the run's JSONL log.
 *
 * Audit events are distinguished from prompt entries by the `"type": "audit_event"`
 * field.  They are written unconditionally at the tool layer so the run audit
 * trail cannot be silently omitted by the orchestrator LLM.
 *
 * @param logPath - JSONL log file path for the current run.
 * @param tool    - Tool name that produced this event.
 * @param event   - Short machine-readable event name (e.g. `"conflict_markers_detected"`).
 * @param details - Optional structured key-value details.
 */
function logAuditEvent(
  logPath: string,
  tool: string,
  event: string,
  details?: Record<string, unknown>,
): void {
  const record = {
    type: "audit_event" as const,
    timestamp: new Date().toISOString(),
    tool,
    event,
    ...(details ? { details } : {}),
  }
  try {
    appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8")
  } catch {
    process.stderr.write(`[AuditLog] Warning: could not write audit event to ${logPath}\n`)
  }
}

// ---------------------------------------------------------------------------
// Syntax balance checker for TypeScript / JavaScript files (Improvement 6)
// ---------------------------------------------------------------------------

const SYNTAX_CHECK_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"])

/**
 * Checks that braces, parentheses, and brackets are balanced in `content`.
 * Only runs for TypeScript/JavaScript files (identified by `filePath` extension).
 *
 * Uses a simplified stripping pass (line comments, block comments, string literals)
 * before counting delimiters.  Designed to catch the most common AI mistakes
 * (truncated output, incomplete code blocks) rather than be a full parser.
 *
 * @returns `{ valid: true }` when balanced, or `{ valid: false, issue }` otherwise.
 */
export function checkSyntaxBalance(
  content: string,
  filePath: string,
): { valid: boolean; issue?: string } {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  if (!SYNTAX_CHECK_EXTENSIONS.has(ext)) return { valid: true }

  // Strip line comments, block comments, and string/template literals.
  // Template literals are stripped as opaque strings (simplified — does not
  // handle nested template expressions, which is fine for this use-case).
  // Strip strings BEFORE comments: a "//" inside a string (e.g. URL) must not
  // be matched by the line-comment regex, which would strip the closing quote
  // and leave unbalanced braces visible to the counter (false positives).
  const stripped = content
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")

  let braces = 0, parens = 0, brackets = 0
  for (const ch of stripped) {
    if (ch === "{") braces++
    else if (ch === "}") { if (--braces < 0) return { valid: false, issue: "Unexpected '}'" } }
    else if (ch === "(") parens++
    else if (ch === ")") { if (--parens < 0) return { valid: false, issue: "Unexpected ')'" } }
    else if (ch === "[") brackets++
    else if (ch === "]") { if (--brackets < 0) return { valid: false, issue: "Unexpected ']'" } }
  }
  if (braces !== 0) return { valid: false, issue: `Unbalanced braces (${braces > 0 ? "unclosed '{'" : "extra '}'"})` }
  if (parens !== 0) return { valid: false, issue: `Unbalanced parentheses (${parens > 0 ? "unclosed '('" : "extra ')'"})` }
  if (brackets !== 0) return { valid: false, issue: `Unbalanced brackets (${brackets > 0 ? "unclosed '['" : "extra ']'"})` }
  return { valid: true }
}

// ---------------------------------------------------------------------------
// Dice-coefficient line similarity — used for consensus comparison (Improvement 5)
// ---------------------------------------------------------------------------

/**
 * Computes the Dice coefficient of two strings compared at the trimmed-line level.
 *
 * A score of `1.0` means both strings share identical non-empty line sets.
 * A score of `0.0` means no lines in common.
 *
 * @returns Number in the range [0, 1].
 */
export function computeLineSimilarity(a: string, b: string): number {
  const linesA = new Set(a.split("\n").map((l) => l.trim()).filter(Boolean))
  const linesB = new Set(b.split("\n").map((l) => l.trim()).filter(Boolean))
  const common = [...linesA].filter((l) => linesB.has(l)).length
  const total = linesA.size + linesB.size
  return total === 0 ? 1 : (2 * common) / total
}

// ---------------------------------------------------------------------------
// Hallucination detector — cross-checks AI references against real files
// (Improvement 8)
// ---------------------------------------------------------------------------

/**
 * Scans free-text fragments for file-path-like references and returns those
 * that do not appear in `actualChangedFiles`.
 *
 * Detected suspects are appended to `semanticRiskFactors` by
 * `analyze_commit_for_backport` so the orchestrator and human reviewer are
 * aware of potentially hallucinated claims.
 *
 * @param textFragments     - Free-text strings (keyChanges, semanticRiskFactors…).
 * @param actualChangedFiles - Ground-truth list of files from `git diff-tree`.
 * @returns Array of suspected hallucinated file references.
 */
export function detectHallucinatedFileRefs(
  textFragments: string[],
  actualChangedFiles: string[],
): string[] {
  // Match file-path-like references including:
  //  - Root-level files with no slash: README.md, config.ts
  //  - Scoped packages: @scope/pkg/file.ts
  //  - Hyphenated paths: cline-sdk/src/index.ts
  // The original \b boundary is removed as it breaks on hyphens and @ prefixes.
  const FILE_REF_RE =
    /(@?(?:[\w.@-][\w.@/-]*\/)*[\w.@-][\w.@-]*\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|json|md|yaml|yml|py|go|rs|java|kt|cs|cpp|c|h|rb|php|swift|sh))/g

  const mentioned = new Set<string>()
  for (const text of textFragments) {
    for (const match of text.matchAll(FILE_REF_RE)) {
      mentioned.add(match[1] ?? match[0])
    }
  }

  return [...mentioned].filter(
    (ref) => !actualChangedFiles.some((cf) => cf === ref || cf.endsWith(`/${ref}`) || cf.includes(ref)),
  )
}

// Infer the keypoolEventHandler type from Agent's constructor options so we
// don't need to import it from @sctg/cline-shared directly.
type KeypoolEventHandler = NonNullable<Parameters<typeof Agent>[0]> extends
  { keypoolEventHandler?: (e: infer E) => void } ? ((e: E) => void) : never

/**
 * Creates a minimal sub-`Agent` for a single-turn AI reasoning call.
 *
 * The sub-agent has an empty tools array — it performs a single reasoning turn
 * and returns its text output via `result.outputText`.
 *
 * @param modelId              - Model identifier to use (fast or powerful).
 * @param systemPrompt         - System prompt that scopes the sub-agent's behaviour.
 * @param providerId           - LLM provider ID (e.g. `"anthropic"`, `"keypoollive"`).
 * @param apiKey               - Resolved API key (or `undefined` to let the SDK discover it).
 * @param keypoolEventHandler  - Optional keypool event handler forwarded from the main agent
 *                               so that sub-agent token usage is tracked in keypoolStats.
 * @returns A configured `Agent` instance ready to call `.run(userPrompt)`.
 */
function makeSubAgent(
  modelId: string,
  systemPrompt: string,
  providerId: string,
  apiKey: string | undefined,
  keypoolEventHandler?: KeypoolEventHandler,
): Agent {
  return new Agent({
    providerId,
    modelId,
    apiKey,
    systemPrompt,
    tools: [],
    ...(keypoolEventHandler ? { keypoolEventHandler } : {}),
  })
}

// ---------------------------------------------------------------------------
// Exported factory
// ---------------------------------------------------------------------------

/**
 * Builds and returns all AI-powered agent tools pre-bound to the provided config.
 *
 * @param config          - Validated `SyncConfig` loaded from `config.json`.
 * @param logPath         - Absolute path to the JSONL prompt log file for this run.
 *                          Created by `main.ts` as `run-<timestamp>.prompts.jsonl`.
 * @param providerId      - LLM provider ID resolved from `config.models.provider`.
 * @param apiKey          - Resolved API key (from config or env); `undefined` for SDK auto-discovery.
 * @param customizations  - Loaded customizations manifest; used to enrich conflict resolution
 *                          prompts with fork-specific context when the caller provides IDs.
 * @returns Array of four agent tools for AI-assisted analysis.
 */
export function makeAiTools(
  config: SyncConfig,
  logPath: string,
  providerId: string,
  apiKey: string | undefined,
  customizations?: Customizations,
  keypoolEventHandler?: KeypoolEventHandler,
) {
  // -------------------------------------------------------------------------
  // Tool 1: resolve_conflict_with_ai
  // -------------------------------------------------------------------------

  /**
   * Tool: resolve_conflict_with_ai
   *
   * Spawns a focused sub-agent to produce a conflict-free merged version of a
   * file that has a three-way merge conflict.
   *
   * The sub-agent receives the base (common ancestor), our (fork) version, and
   * their (upstream) version of the file, together with the upstream commit
   * message for context.  It reasons about the intent of each side and returns
   * a merged body with no conflict markers.
   *
   * Uses `config.models.powerful` because incorrect conflict resolution can
   * silently break fork-specific behaviour.
   */
  const resolveConflictTool = defineTool({
    name: "resolve_conflict_with_ai",
    description:
      "Resolves a three-way merge conflict in a single file using AI reasoning. " +
      "Provide the base (common ancestor), our (fork) version, and their (upstream) version " +
      "of the file, plus the upstream commit message for context. " +
      "Returns the resolved file content with no conflict markers, a confidence level, " +
      "and a brief reasoning summary. " +
      "Use this when cherry_pick_commit reports a conflict and you need to resolve a specific file.",
    inputSchema: z.object({
      /**
       * Repository-relative path to the conflicted file (e.g. `src/core/api/index.ts`).
       * Used only for display/reasoning context — no filesystem access is performed.
       */
      filePath: z.string().describe("Repo-relative path of the conflicted file"),

      /**
       * Content of the file at the common ancestor commit (merge base).
       * May be an empty string when the file was created on both branches independently.
       */
      baseContent: z.string().describe("File content at the common ancestor (merge base); empty string if none"),

      /**
       * Content of the file in the fork branch (our version, with our customisations).
       */
      ourContent: z.string().describe("File content in the fork branch (our customised version)"),

      /**
       * Content of the file in the upstream commit (their version).
       */
      theirContent: z.string().describe("File content from the upstream commit (their version)"),

      /**
       * The full commit message of the upstream change being cherry-picked.
       * Helps the model understand the intent of the upstream change.
       */
      commitMessage: z.string().describe("Upstream commit message, used to understand the intent of the change"),

      /**
       * Optional: a human-readable note describing relevant fork customisations
       * in this file (e.g. "This file contains the keypoollive provider registration").
       * When provided, the model uses it to decide which parts must not be overwritten.
       * If omitted but `affectedCustomizationIds` is supplied, the note is built
       * automatically from the customizations manifest.
       */
      customizationNote: z
        .string()
        .optional()
        .describe("Optional description of fork customisations in this file to help preserve them"),

      /**
       * IDs of `CustomizationEntry` objects (from `classify_commit_risk.customizationIds`)
       * that overlap with the file being resolved.  When provided and no explicit
       * `customizationNote` is given, the descriptions and invariants of these
       * entries are injected into the conflict resolution prompt automatically.
       */
      affectedCustomizationIds: z
        .array(z.string())
        .optional()
        .describe("Customization IDs from classify_commit_risk that overlap with this file"),
    }),
    execute: async ({ filePath, baseContent, ourContent, theirContent, commitMessage, customizationNote, affectedCustomizationIds }) => {
      /**
       * System prompt focuses the sub-agent exclusively on conflict resolution.
       * The model must output only a single JSON object.
       */
      const systemPrompt = [
        "You are an expert software engineer specialising in Git merge conflict resolution.",
        "Your sole task is to produce a clean merged version of a conflicted file.",
        "",
        "Rules:",
        "- Output ONLY a valid JSON object. No prose, no explanations outside the JSON.",
        '- The JSON must have exactly three fields: "resolvedContent", "confidence", "reasoning".',
        '- "resolvedContent": the complete resolved file content as a string. MUST contain zero conflict markers (<<<<<<<, =======, >>>>>>>).',
        '- "confidence": one of "high", "medium", or "low".',
        '  - "high": you are certain the resolution is correct and preserves all intent.',
        '  - "medium": the resolution is plausible but you had to make a judgment call.',
        '  - "low": the resolution is uncertain; a human should review it.',
        '- "reasoning": a single sentence explaining the key decision you made.',
        "",
        "Resolution strategy:",
        "1. Understand what the UPSTREAM change was trying to achieve (read the commit message).",
        "2. Understand what the FORK version preserves (customisations, local patches).",
        "3. Integrate both intents: keep fork customisations AND apply the upstream change where safe.",
        "4. When in doubt, prefer preserving fork customisations and mark confidence as 'low'.",
      ].join("\n")

      // Build the customization context section:
      // 1. Use the explicitly provided note if present.
      // 2. Otherwise auto-build from affectedCustomizationIds + loaded manifest.
      let resolvedCustomizationNote = customizationNote
      if (!resolvedCustomizationNote && affectedCustomizationIds?.length && customizations) {
        const entries = customizations.customizations.filter((c) =>
          affectedCustomizationIds.includes(c.id),
        )
        if (entries.length > 0) {
          resolvedCustomizationNote = entries
            .map((c) => {
              const invariantLine =
                c.invariants.length > 0 ? `\n  Invariants: ${c.invariants.join("; ")}` : ""
              return `• ${c.id}: ${c.description}${invariantLine}`
            })
            .join("\n")
        }
      }

      const customizationSection = resolvedCustomizationNote
        ? `\nFork customisation context:\n${resolvedCustomizationNote}\n`
        : ""

      const userPrompt =
        `Resolve the merge conflict in file: ${filePath}\n` +
        `Upstream commit message: ${commitMessage}\n` +
        customizationSection +
        `\n--- BASE (common ancestor) ---\n${baseContent || "(file did not exist at merge base)"}\n` +
        `\n--- OURS (fork version) ---\n${ourContent}\n` +
        `\n--- THEIRS (upstream version) ---\n${theirContent}\n` +
        `\nOutput the JSON object now.`

      // Try specialist model first; fall back to powerful on any failure.
      const modelsToTry = [
        { modelId: config.models.specialist, label: "specialist" },
        { modelId: config.models.powerful, label: "powerful" },
      ]

      // Regex for conflict markers — checked inside resolvedContent (Improvement 2).
      const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m

      let lastError: string | null = null
      for (const [idx, { modelId, label }] of modelsToTry.entries()) {
        // Brief pause before fallback attempts: if the first model failed due to a
        // rate-limit or transient error, hitting the second model immediately may
        // encounter the same condition.  A 2-second delay costs little latency but
        // substantially improves success rates under provider rate-pressure.
        if (idx > 0 && lastError !== null) {
          await new Promise((r) => setTimeout(r, 2_000))
        }
        try {
          const subAgent = makeSubAgent(modelId, systemPrompt, providerId, apiKey, keypoolEventHandler)
          const t0 = Date.now()
          const result = await subAgent.run(userPrompt)
          const durationMs = Date.now() - t0

          // --- Improvement 1: Zod schema validation ---
          const rawOutput = extractJson<unknown>(result.outputText ?? "")
          const validated = ConflictResolutionOutputSchema.safeParse(rawOutput)
          if (!validated.success) {
            const zodErr = validated.error.message
            logPrompt(logPath, "resolve_conflict_with_ai", modelId, userPrompt, result.outputText ?? "", durationMs, `Schema validation failed: ${zodErr}`)
            logAuditEvent(logPath, "resolve_conflict_with_ai", "schema_validation_failed", { modelId, label, error: zodErr })
            lastError = `Schema validation failed: ${zodErr}`
            process.stderr.write(
              `[resolve_conflict_with_ai] ${label} model (${modelId}) returned invalid schema: ${zodErr.slice(0, 120)} — ${
                label === "specialist" ? "retrying with powerful model" : "giving up"
              }\n`,
            )
            continue
          }
          const output = validated.data

          // --- Improvement 2: conflict marker guard ---
          const hasConflictMarkers = CONFLICT_MARKER_RE.test(output.resolvedContent)

          // --- Improvement 6: syntax balance check (TS/JS only) ---
          const syntaxCheck = checkSyntaxBalance(output.resolvedContent, filePath)

          // Effective confidence after guards.
          let effectiveConfidence = output.confidence
          const guards: string[] = []

          if (hasConflictMarkers) {
            effectiveConfidence = "low"
            guards.push("conflict_markers_detected")
            logAuditEvent(logPath, "resolve_conflict_with_ai", "conflict_markers_detected", { filePath, modelId })
            process.stderr.write(
              `[resolve_conflict_with_ai] GUARD: conflict markers in output for ${filePath} — downgrading confidence to low\n`,
            )
          }

          if (!syntaxCheck.valid) {
            effectiveConfidence = "low"
            guards.push(`syntax_issue:${syntaxCheck.issue}`)
            logAuditEvent(logPath, "resolve_conflict_with_ai", "syntax_validation_failed", {
              filePath,
              modelId,
              issue: syntaxCheck.issue,
            })
            process.stderr.write(
              `[resolve_conflict_with_ai] GUARD: syntax check failed for ${filePath}: ${syntaxCheck.issue} — downgrading confidence to low\n`,
            )
          }

          // --- Improvement 5: self-consistency consensus (opt-in) ---
          let consensusFailure = false
          if (config.ai.enableConflictConsensus && label === "specialist" && !hasConflictMarkers) {
            try {
              const consensusAgent = makeSubAgent(config.models.powerful, systemPrompt, providerId, apiKey, keypoolEventHandler)
              const ct0 = Date.now()
              const consensusResult = await consensusAgent.run(userPrompt)
              const consensusDurationMs = Date.now() - ct0
              const consensusValidated = ConflictResolutionOutputSchema.safeParse(
                extractJson<unknown>(consensusResult.outputText ?? ""),
              )
              if (consensusValidated.success) {
                const similarity = computeLineSimilarity(
                  output.resolvedContent,
                  consensusValidated.data.resolvedContent,
                )
                logPrompt(
                  logPath,
                  "resolve_conflict_with_ai:consensus",
                  config.models.powerful,
                  userPrompt,
                  consensusResult.outputText ?? "",
                  consensusDurationMs,
                  null,
                  consensusResult.usage,
                  { consensus: true, similarity },
                )
                if (similarity < config.ai.conflictConsensusThreshold) {
                  effectiveConfidence = "low"
                  consensusFailure = true
                  guards.push(`consensus_divergence:${similarity.toFixed(2)}`)
                  logAuditEvent(logPath, "resolve_conflict_with_ai", "consensus_divergence", {
                    filePath,
                    similarity,
                    threshold: config.ai.conflictConsensusThreshold,
                  })
                  process.stderr.write(
                    `[resolve_conflict_with_ai] CONSENSUS: models diverged (similarity=${similarity.toFixed(2)}, threshold=${config.ai.conflictConsensusThreshold}) for ${filePath} — downgrading to low\n`,
                  )
                } else {
                  logAuditEvent(logPath, "resolve_conflict_with_ai", "consensus_passed", { filePath, similarity })
                }
              }
            } catch (consensusErr) {
              const msg = consensusErr instanceof Error ? consensusErr.message : String(consensusErr)
              process.stderr.write(`[resolve_conflict_with_ai] Consensus check failed (non-fatal): ${msg}\n`)
            }
          }

          const reasoning =
            guards.length > 0 ? `[GUARD: ${guards.join(", ")}] ${output.reasoning}` : output.reasoning

          logPrompt(
            logPath,
            "resolve_conflict_with_ai",
            modelId,
            userPrompt,
            result.outputText ?? "",
            durationMs,
            null,
            result.usage,
            {
              originalConfidence: output.confidence,
              effectiveConfidence,
              hasConflictMarkers,
              syntaxValid: syntaxCheck.valid,
              consensusFailure,
              guards,
            },
          )
          logAuditEvent(logPath, "resolve_conflict_with_ai", "resolution_complete", {
            filePath,
            modelId,
            label,
            originalConfidence: output.confidence,
            effectiveConfidence,
            guards,
          })

          return {
            resolvedContent: output.resolvedContent,
            confidence: effectiveConfidence,
            reasoning,
            error: null,
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)

          // Check for timeout errors and log with enhanced verbosity
          if (isTimeoutError(lastError)) {
            logTimeoutError(logPath, "resolve_conflict_with_ai", lastError, {
              filePath,
              commitMessage,
              modelId,
              label,
              durationMs: 0 // We don't have the exact duration in catch block
            })
          }

          process.stderr.write(
            `[resolve_conflict_with_ai] ${label} model (${modelId}) failed: ${lastError.slice(0, 120)} — ${
              label === "specialist" ? "retrying with powerful model" : "giving up"
            }\n`,
          )
          logPrompt(logPath, "resolve_conflict_with_ai", modelId, userPrompt, "", 0, lastError)
        }
      }

      logAuditEvent(logPath, "resolve_conflict_with_ai", "resolution_failed", { filePath, error: lastError })
      return {
        resolvedContent: "",
        confidence: "low" as const,
        reasoning: `AI resolution failed on all models: ${lastError}`,
        error: lastError,
      }
    },
  })

  // -------------------------------------------------------------------------
  // Tool 2: analyze_commit_for_backport
  // -------------------------------------------------------------------------

  /**
   * Tool: analyze_commit_for_backport
   *
   * Spawns a sub-agent to produce a semantic assessment of an upstream commit
   * and its implications for the fork.
   *
   * Unlike the deterministic `classify_commit_risk` tool, this tool reasons
   * about the *intent* of the commit: what architectural or behavioural change
   * it introduces, whether it touches concepts relevant to the fork's
   * customisations, and what the recommended backport action is.
   *
   * Uses `config.models.fast` (analytical, not on the critical path).
   */
  const analyzeCommitTool = defineTool({
    name: "analyze_commit_for_backport",
    description:
      "Performs a semantic analysis of an upstream commit to understand its intent and " +
      "assess how complex it is to backport into the fork. " +
      "Returns a structured assessment with a human-readable summary, key changes, " +
      "complexity rating, semantic risk factors, and a backport recommendation. " +
      "Use this before cherry-picking a high-risk commit to better understand what it does.",
    inputSchema: z.object({
      /**
       * Full commit SHA (40-character hex string).
       */
      sha: z.string().describe("Full commit SHA"),

      /**
       * The commit's subject + body as returned by `git log --format=%B`.
       */
      commitMessage: z.string().describe("Full commit message (subject + body)"),

      /**
       * List of file paths changed by this commit (relative to repo root).
       * Available from `get_commit_details` without requesting the diff.
       */
      changedFiles: z.array(z.string()).describe("List of file paths changed by this commit"),
    }),
    execute: async ({ sha, commitMessage, changedFiles }) => {
      // Fetch the diff internally — keeps it out of the main orchestrator context.
      const diff = getCommitDiff(config.workingDir, sha)
      // Large diffs (e.g. bun.lock releases) get the powerful model for better reasoning
      // and a potentially different quota pool (fewer rate-limit issues).
      const analysisModel = diff.length > config.ai.largeContextThreshold
        ? config.models.powerful
        : config.models.fast
      // Build the fork customization context block once per tool factory (static).
      const forkContextLines: string[] =
        customizations?.customizations.length
          ? [
              "This fork has the following customization zones (files in these zones are fork-specific):",
              ...customizations.customizations.map(
                (c) => `  - ${c.id}: ${c.description} (paths: ${c.paths.join(", ")})`,
              ),
              "If this commit modifies files that fall inside these zones, flag it as high-risk.",
              "",
            ]
          : []

      const systemPrompt = [
        "You are an expert software engineer specialising in Git history analysis.",
        "Your task is to analyse a single upstream commit and assess how complex it is to",
        "backport it into a heavily customised fork.",
        "",
        ...forkContextLines,
        "CRITICAL: Be extremely concise. Your entire response must fit in 400 tokens or less.",
        "Output ONLY a valid JSON object with exactly these fields:",
        '  "summary":             string  — max 2 sentences, under 100 words.',
        '  "keyChanges":          string[] — at most 5 items, each under 20 words.',
        '  "backportComplexity":  "trivial" | "moderate" | "complex"',
        '    - "trivial":   small, isolated change with no side effects.',
        '    - "moderate":  meaningful change but scope is clear and contained.',
        '    - "complex":   refactor, API change, or broad change that may interact with customisations.',
        '  "semanticRiskFactors": string[] — at most 3 items, each under 30 words.',
        '                         (e.g. "renames exported interface", "changes provider registration pattern").',
        '                         Empty array if no risks detected.',
        '  "recommendation":      "apply" | "apply-with-care" | "review-required" | "skip"',
        '    - "apply":            safe to cherry-pick automatically.',
        '    - "apply-with-care":  cherry-pick but verify validation passes.',
        '    - "review-required":  human should review before merging.',
        '    - "skip":             commit should not be backported.',
      ].join("\n")

      const userPrompt =
        `Commit SHA: ${sha}\n` +
        `Commit message:\n${commitMessage}\n\n` +
        `Changed files (${changedFiles.length}):\n${changedFiles.join("\n")}\n\n` +
        `Diff:\n${diff}\n\n` +
        `Output the JSON object now.`

      try {
        const subAgent = makeSubAgent(analysisModel, systemPrompt, providerId, apiKey, keypoolEventHandler)
        const t0 = Date.now()
        const result = await subAgent.run(userPrompt)
        const durationMs = Date.now() - t0

        // Check for timeout errors and log with enhanced verbosity
        if (result.error) {
          const errorMessage = result.error instanceof Error ? result.error.message : String(result.error)
          if (isTimeoutError(errorMessage)) {
            logTimeoutError(logPath, "analyze_commit_for_backport", errorMessage, {
              sha,
              commitMessage,
              durationMs,
              model: analysisModel
            })
          }
        }

        // --- Improvement 1: Zod schema validation ---
        const rawOutput = extractJson<unknown>(result.outputText ?? "")
        const validated = AnalyzeCommitOutputSchema.safeParse(rawOutput)
        if (!validated.success) {
          throw new Error(`Schema validation failed: ${validated.error.message}`)
        }
        const output = validated.data

        // --- Improvement 8: hallucination detection ---
        const hallucinationSuspects = detectHallucinatedFileRefs(
          [...output.keyChanges, ...output.semanticRiskFactors],
          changedFiles,
        )
        if (hallucinationSuspects.length > 0) {
          output.semanticRiskFactors.push(
            `[AUDIT] ${hallucinationSuspects.length} possible hallucinated file reference(s) not found in diff: ${hallucinationSuspects.slice(0, 5).join(", ")}`,
          )
          logAuditEvent(logPath, "analyze_commit_for_backport", "hallucination_suspects", {
            sha,
            suspects: hallucinationSuspects,
          })
        }

        logPrompt(
          logPath,
          "analyze_commit_for_backport",
          analysisModel,
          userPrompt,
          result.outputText ?? "",
          durationMs,
          null,
          result.usage,
          {
            recommendation: output.recommendation,
            backportComplexity: output.backportComplexity,
            semanticRiskFactorsCount: output.semanticRiskFactors.length,
            hallucinationSuspectsCount: hallucinationSuspects.length,
          },
        )
        logAuditEvent(logPath, "analyze_commit_for_backport", "analysis_complete", {
          sha,
          recommendation: output.recommendation,
          complexity: output.backportComplexity,
          riskFactors: output.semanticRiskFactors.length,
          hallucinationSuspects: hallucinationSuspects.length,
        })

        return {
          summary: output.summary,
          keyChanges: output.keyChanges,
          backportComplexity: output.backportComplexity,
          semanticRiskFactors: output.semanticRiskFactors,
          recommendation: output.recommendation,
          error: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logPrompt(logPath, "analyze_commit_for_backport", analysisModel, userPrompt, "", 0, message)
        logAuditEvent(logPath, "analyze_commit_for_backport", "analysis_failed", { sha, error: message })
        return {
          summary: `Analysis failed: ${message}`,
          keyChanges: [],
          backportComplexity: "complex" as const,
          semanticRiskFactors: [`AI analysis unavailable: ${message}`],
          recommendation: "review-required" as const,
          error: message,
        }
      }
    },
  })

  // -------------------------------------------------------------------------
  // Tool 3: check_customization_compatibility
  // -------------------------------------------------------------------------

  /**
   * Tool: check_customization_compatibility
   *
   * Spawns a sub-agent to reason about whether an upstream diff is semantically
   * compatible with the fork's declared customisations.
   *
   * The deterministic `classify_commit_risk` tool matches file globs to flag
   * risky commits.  This tool goes further: it reads the *descriptions* of
   * customisations and asks the model whether the upstream change could break
   * the described behaviour, even if the changed files don't match the glob.
   *
   * Uses `config.models.fast` (fast reasoning, results used to augment the
   * main agent's risk assessment rather than as a hard gate).
   */
  const checkCompatibilityTool = defineTool({
    name: "check_customization_compatibility",
    description:
      "Checks whether an upstream diff is semantically compatible with the fork's customisations. " +
      "Goes beyond file-path glob matching: the AI reads the customisation descriptions and " +
      "reasons about whether the upstream change could break declared fork-specific behaviour. " +
      "Returns a compatibility verdict, a list of affected customisations, semantic conflicts, " +
      "warnings, and a recommendation. " +
      "Use this when classify_commit_risk returns 'medium' or 'high' and you want deeper insight.",
    inputSchema: z.object({
      /**
       * Full commit SHA — the diff is fetched internally to avoid duplicating it
       * in the main orchestrator context.
       */
      sha: z.string().describe("Full commit SHA to evaluate"),

      /**
       * List of customisation entries loaded from `customizations.yaml`.
       * Each entry has a glob pattern (identifying which files are customised)
       * and a human-readable description of what the customisation does.
       */
      customizations: z
        .array(
          z.object({
            /**
             * Glob pattern (e.g. `src/core/api/providers/**`) identifying files
             * that belong to this customisation zone.
             */
            pattern: z.string().describe("Glob pattern for customised file paths"),
            /**
             * Human-readable description of what this customisation does and why
             * it must be preserved.
             */
            description: z.string().describe("Description of the fork customisation"),
          }),
        )
        .describe("Customisation entries from customizations.yaml"),
    }),
    execute: async ({ sha, customizations }) => {
      // Fetch the diff internally — keeps it out of the main orchestrator context.
      const diff = getCommitDiff(config.workingDir, sha)
      // Route to powerful model for large diffs.
      const compatModel = diff.length > config.ai.largeContextThreshold
        ? config.models.powerful
        : config.models.fast

      /**
       * If there are no customisations defined, there is nothing to check.
       * Return a trivially compatible result without calling the LLM.
       */
      if (customizations.length === 0) {
        return {
          compatible: true,
          affectedCustomizations: [],
          semanticConflicts: [],
          warnings: [],
          recommendation: "No customisations defined; upstream change is safe to apply.",
          error: null,
        }
      }

      // --- Improvement 4: enrich each customization with actual file content ---
      const customizationList = (
        await Promise.all(
          customizations.map(async (c, i) => {
            let contentSnippet = ""
            if (config.ai.enrichCustomizationContext) {
              try {
                // globSync is available since Node.js v22 (required by engines field).
                const matchedPaths = globSync(c.pattern, { cwd: config.workingDir })
                  .filter(Boolean)
                  .slice(0, 2)
                const fileSnippets = matchedPaths
                  .filter((f) => f !== "")
                  .map((f) => {
                    const content = readFileSync(joinPath(config.workingDir, f), "utf8").slice(0, 2000)
                    return `[${f}]\n${content.split("\n").map((l) => "      " + l).join("\n")}`
                  })
                if (fileSnippets.length > 0) {
                  contentSnippet = `\n     Current file content (${fileSnippets.length} file(s)):\n      ${fileSnippets.join("\n      ---\n")}`
                }
              } catch {
                // Content enrichment is best-effort \u2014 never block a run.
              }
            }
            return `  ${i + 1}. Pattern: ${c.pattern}\n     Description: ${c.description}${contentSnippet}`
          }),
        )
      ).join("\n")

      const systemPrompt = [
        "You are an expert software engineer specialising in fork maintenance and semantic conflict detection.",
        "Your task is to assess whether an upstream Git diff could break the customised behaviour",
        "of a fork, given a list of declared customisations.",
        "",
        "CRITICAL: Be extremely concise. Your entire response must fit in 300 tokens or less.",
        "Output ONLY a valid JSON object with exactly these fields:",
        '  "compatible":             boolean — true if the upstream change is unlikely to break any customisation.',
        '  "affectedCustomizations": string[] — at most 5 items, each under 100 chars.',
        '  "semanticConflicts":      string[] — at most 3 items, each under 200 chars.',
        '                            Each entry is a concrete description (e.g. "renames ApiProvider enum',
        '                            value used by keypoollive provider registration").',
        '                            Empty array if no conflicts detected.',
        '  "warnings":               string[] — at most 3 items, each under 200 chars.',
        '                            Empty array if none.',
        '  "recommendation":         string — one sentence (under 300 chars) advising the agent what to do.',
        "",
        "Important: focus on SEMANTIC compatibility, not textual conflicts.",
        "A change can be textually clean but still break the fork (e.g. renaming an interface",
        "that the fork's custom provider implements).",
      ].join("\n")

      const userPrompt =
        `Declared fork customisations:\n${customizationList}\n\n` +
        `Upstream diff to evaluate:\n${diff}\n\n` +
        `Output the JSON object now.`

      try {
        const subAgent = makeSubAgent(compatModel, systemPrompt, providerId, apiKey, keypoolEventHandler)
        const t0 = Date.now()
        const result = await subAgent.run(userPrompt)
        const durationMs = Date.now() - t0

        // Check for timeout errors and log with enhanced verbosity
        if (result.error) {
          const errorMessage = result.error instanceof Error ? result.error.message : String(result.error)
          if (isTimeoutError(errorMessage)) {
            logTimeoutError(logPath, "check_customization_compatibility", errorMessage, {
              durationMs,
              model: compatModel,
              customizationCount: customizations.length
            })
          }
        }

        // --- Improvement 1: Zod schema validation ---
        const rawOutput = extractJson<unknown>(result.outputText ?? "")
        const validated = CheckCompatibilityOutputSchema.safeParse(rawOutput)
        if (!validated.success) {
          throw new Error(`Schema validation failed: ${validated.error.message}`)
        }
        const output = validated.data

        logPrompt(
          logPath,
          "check_customization_compatibility",
          compatModel,
          userPrompt,
          result.outputText ?? "",
          durationMs,
          null,
          result.usage,
          {
            compatible: output.compatible,
            affectedCount: output.affectedCustomizations.length,
            semanticConflictsCount: output.semanticConflicts.length,
            fileContentEnriched: config.ai.enrichCustomizationContext,
          },
        )
        logAuditEvent(logPath, "check_customization_compatibility", "compatibility_check_complete", {
          compatible: output.compatible,
          affectedCustomizations: output.affectedCustomizations,
          semanticConflictsCount: output.semanticConflicts.length,
          fileContentEnriched: config.ai.enrichCustomizationContext,
        })

        return {
          compatible: output.compatible,
          affectedCustomizations: output.affectedCustomizations,
          semanticConflicts: output.semanticConflicts,
          warnings: output.warnings,
          recommendation: output.recommendation,
          error: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logPrompt(logPath, "check_customization_compatibility", config.models.fast, userPrompt, "", 0, message)
        logAuditEvent(logPath, "check_customization_compatibility", "compatibility_check_failed", { error: message })
        return {
          compatible: false,
          affectedCustomizations: [],
          semanticConflicts: [],
          warnings: [`AI compatibility check failed: ${message}`],
          recommendation: "Treat as potentially incompatible; request human review.",
          error: message,
        }
      }
    },
  })

  // -------------------------------------------------------------------------
  // Tool 4: reconcile_ai_assessments  (Improvements 3 + 10)
  // -------------------------------------------------------------------------

  /**
   * Tool: reconcile_ai_assessments
   *
   * Deterministic (no LLM) reconciliation of `analyze_commit_for_backport` and
   * `check_customization_compatibility` outputs.
   *
   * Detects contradictions between the two AI assessments and always resolves
   * ambiguity conservatively (more-restrictive recommendation wins).  When
   * `config.ai.requireReviewOnSemanticRisk` is enabled, commits with semantic
   * risk factors are escalated to "review-required" regardless of the individual
   * AI recommendations.
   *
   * Calling this tool after both analysis tools have run produces a single,
   * audited final recommendation the orchestrator can act on directly.
   */
  const reconcileAssessmentsTool = defineTool({
    name: "reconcile_ai_assessments",
    description:
      "Reconciles potentially contradictory outputs from analyze_commit_for_backport and " +
      "check_customization_compatibility into a single audited recommendation. " +
      "Detects contradictions and always takes the more conservative path. " +
      "No AI call is made \u2014 this is a fast deterministic step. " +
      "Call this after both analyze_commit_for_backport and check_customization_compatibility " +
      "have been invoked for the same commit.",
    inputSchema: z.object({
      /** Commit SHA being reconciled (for audit logging). */
      sha: z.string().describe("Commit SHA being evaluated"),
      /** `recommendation` from `analyze_commit_for_backport`. */
      analyzeRecommendation: z
        .enum(["apply", "apply-with-care", "review-required", "skip"])
        .describe("Recommendation from analyze_commit_for_backport"),
      /** `semanticRiskFactors` from `analyze_commit_for_backport`. */
      analyzeSemanticRiskFactors: z
        .array(z.string())
        .describe("Semantic risk factors from analyze_commit_for_backport"),
      /** `compatible` field from `check_customization_compatibility`. */
      compatibilityCompatible: z
        .boolean()
        .describe("compatible field from check_customization_compatibility"),
      /** `semanticConflicts` from `check_customization_compatibility`. */
      compatibilitySemanticConflicts: z
        .array(z.string())
        .describe("semanticConflicts array from check_customization_compatibility"),
      /** `recommendation` from `check_customization_compatibility`. */
      compatibilityRecommendation: z
        .string()
        .describe("recommendation field from check_customization_compatibility"),
    }),
    execute: async ({
      sha,
      analyzeRecommendation,
      analyzeSemanticRiskFactors,
      compatibilityCompatible,
      compatibilitySemanticConflicts,
      compatibilityRecommendation,
    }) => {
      // Severity scale: lower = more permissive.
      const SEVERITY: Record<string, number> = {
        apply: 0,
        "apply-with-care": 1,
        "review-required": 2,
        skip: 3,
      }
      const TO_REC = ["apply", "apply-with-care", "review-required", "skip"] as const

      const analyzeSev = SEVERITY[analyzeRecommendation] ?? 2
      // If check_compatibility says not compatible, treat as at-least "review-required".
      const compatSev = compatibilityCompatible ? 0 : 2

      // Merge the two severity scores according to config.ai.reconciliationMode.
      let finalSev: number
      const mode = config.ai.reconciliationMode ?? "conservative"
      if (mode === "conservative") {
        // Default: always take the more restrictive recommendation.
        finalSev = Math.max(analyzeSev, compatSev)
      } else if (mode === "optimistic") {
        // Take the more permissive recommendation (faster throughput, less safe).
        finalSev = Math.min(analyzeSev, compatSev)
      } else {
        // Weighted blend: round the weighted average to the nearest severity level.
        const w = config.ai.analyzeWeight ?? 0.5
        finalSev = Math.round(w * analyzeSev + (1 - w) * compatSev)
        finalSev = Math.max(0, Math.min(3, finalSev))
      }

      // Apply config.ai.requireReviewOnSemanticRisk (Improvement 10).
      if (config.ai.requireReviewOnSemanticRisk && analyzeSemanticRiskFactors.length > 0) {
        finalSev = Math.max(finalSev, 2) // at least "review-required"
      }

      const finalRecommendation = TO_REC[Math.min(finalSev, 3)] ?? "review-required"

      // Contradiction: analyze said "apply"/"apply-with-care" but check_compatibility found issues.
      const contradictionDetected = analyzeSev < 2 && !compatibilityCompatible

      const reasons: string[] = []
      if (contradictionDetected) {
        reasons.push(
          `Contradiction: analyze_commit recommended \u201c${analyzeRecommendation}\u201d ` +
            `but check_customization_compatibility found compatibility issues`,
        )
      }
      if (compatibilitySemanticConflicts.length > 0) {
        reasons.push(`Semantic conflicts: ${compatibilitySemanticConflicts.slice(0, 3).join("; ")}`)
      }
      if (analyzeSemanticRiskFactors.length > 0) {
        reasons.push(`Risk factors: ${analyzeSemanticRiskFactors.slice(0, 3).join("; ")}`)
      }
      if (config.ai.requireReviewOnSemanticRisk && analyzeSemanticRiskFactors.length > 0 && finalSev >= 2) {
        reasons.push(`Escalated: requireReviewOnSemanticRisk=true with ${analyzeSemanticRiskFactors.length} risk factor(s)`)
      }

      logAuditEvent(logPath, "reconcile_ai_assessments", contradictionDetected ? "contradiction_detected" : "no_contradiction", {
        sha,
        analyzeRecommendation,
        compatibilityCompatible,
        finalRecommendation,
        compatibilityRecommendation,
      })

      return {
        finalRecommendation,
        contradictionDetected,
        unifiedReasoning:
          reasons.join(" | ") || `Both AI tools agree: proceed with \u201c${finalRecommendation}\u201d`,
      }
    },
  })

  // Return all four tools in a single array for spreading into the main Agent.
  return [resolveConflictTool, analyzeCommitTool, checkCompatibilityTool, reconcileAssessmentsTool]
}
```

### `src/cli/args.ts`

**Exports:** parseCliArgs

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file args.ts
 *
 * CLI argument parsing and help functionality for the Backport Agent.
 * Handles command-line argument extraction, validation, and help display.
 */
/// <reference types="node" />

// ---------------------------------------------------------------------------
// CLI argument parsing — runs before .env loading so flags can override env.
// ---------------------------------------------------------------------------

/**
 * Parses command line arguments and sets up environment variables.
 * This runs before .env loading so CLI flags can override environment variables.
 */
export function parseCliArgs(): void {
  const argv = process.argv.slice(2)

  function getArgValue(name: string): string | undefined {
    const idx = argv.indexOf(name)
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined
  }

  function hasFlag(name: string): boolean {
    return argv.includes(name)
  }

  function isHelpRequest(): boolean {
    return hasFlag("--help") || hasFlag("-h")
  }

  function printHelp(): void {
    console.log(`Backport Agent CLI

Usage:
  backport-agent [options]

Options:
  --help, -h                            Show this help message
  --config <path>                       Path to config.json
  --backport-customizations <path|url>  Override customizations source
  --provider <id>                       Override config.models.provider
                                        (e.g. anthropic, openai, mistral, gemini, keypoollive)
  --api-key <key>                       Override config.models.apiKey
                                        Use \$ENV_VAR syntax to read from an env variable
  --list-backport-needed                Print pending upstream commits and exit (no agent run)
  --dry-run                             Run without pushing changes
  --verbose                             Enable verbose logs

keypoollive provider options:
  --keypool-vault-url <url>             Override KEYPOOL_VAULT_URL
  --keypool-live-secret <secret>        Override KEYPOOL_LIVE_SECRET
  --keypool-state-file <path>           Override KEYPOOL_STATE_FILE

Note: config.json is only required for an actual run; this help text works without a config file.
All --provider/--api-key flags take precedence over values in config.json.
`)
  }

  if (isHelpRequest()) {
    printHelp()
    process.exit(0)
  }

  if (hasFlag("--verbose")) process.env.VERBOSE = "true"
  if (hasFlag("--dry-run")) process.env.DRY_RUN = "true"
  if (hasFlag("--list-backport-needed")) process.env._CLI_LIST_BACKPORT_NEEDED = "true"
  const cliConfig = getArgValue("--config")
  if (cliConfig) process.env._CLI_CONFIG_PATH = cliConfig
  const cliCustomizations = getArgValue("--backport-customizations")
  if (cliCustomizations) process.env.BACKPORT_CUSTOMIZATIONS = cliCustomizations
  const cliProvider = getArgValue("--provider")
  if (cliProvider) process.env._CLI_PROVIDER = cliProvider
  const cliApiKey = getArgValue("--api-key")
  if (cliApiKey) process.env._CLI_API_KEY = cliApiKey
  // keypoollive-specific env var overrides
  const cliVaultUrl = getArgValue("--keypool-vault-url")
  if (cliVaultUrl) process.env.KEYPOOL_VAULT_URL = cliVaultUrl
  const cliLiveSecret = getArgValue("--keypool-live-secret")
  if (cliLiveSecret) process.env.KEYPOOL_LIVE_SECRET = cliLiveSecret
  const cliStateFile = getArgValue("--keypool-state-file")
  if (cliStateFile) process.env.KEYPOOL_STATE_FILE = cliStateFile
}
```

### `src/config/loader.ts`

**Exports:** loadConfig

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file config/loader.ts
 *
 * Loads and validates the agent's main configuration from a JSON file.
 *
 * Resolution order for the config path (first match wins):
 *  1. Explicit `configPath` argument passed by the caller.
 *  2. The `BACKPORT_CONFIG` environment variable.
 *  3. `config.json` in the current working directory.
 *
 * Environment variable overrides applied after parsing:
 *  - `DRY_RUN=true`       → forces `sync.dryRun = true` regardless of the JSON value.
 *  - `_CLI_PROVIDER=<id>` → overrides `models.provider` (set by `--provider` flag).
 *  - `_CLI_API_KEY=<key>` → overrides `models.apiKey` (set by `--api-key` flag).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { SyncConfigSchema, type SyncConfig } from "./schema.js"

/**
 * Read, parse, and validate the agent configuration file.
 *
 * The raw JSON is parsed first, then any environment-variable overrides are
 * merged in before the result is validated through `SyncConfigSchema.parse()`.
 * Zod will throw a descriptive `ZodError` if required fields are missing or
 * have the wrong type.
 *
 * @param configPath - Optional explicit path to a `config.json` file.
 *                     Falls back to `BACKPORT_CONFIG` env var, then `./config.json`.
 * @returns A fully validated `SyncConfig` object with all defaults applied.
 * @throws {Error} If the file cannot be read or cannot be parsed as JSON.
 * @throws {ZodError} If the JSON structure does not satisfy `SyncConfigSchema`.
 */
export function loadConfig(configPath?: string): SyncConfig {
  // Determine which config file to read, in priority order.
  const path = configPath ?? process.env.BACKPORT_CONFIG ?? resolve(process.cwd(), "config.json")

  // Read synchronously — startup is blocking by design; no need for async here.
  const raw = JSON.parse(readFileSync(path, "utf-8"))

  // Ensure optional top-level sections exist so nested defaults are always applied.
  raw.sync ??= {}
  raw.models ??= {}
  raw.validation ??= {}

  // Environment variable overrides — applied before Zod validation so that
  // field-level constraints (e.g. type checks) still apply to the final values.
  // KEYPOOL_VAULT_URL / KEYPOOL_LIVE_SECRET are consumed directly by the
  // keypoollive provider SDK — they are not stored in the schema.

  if (process.env.DRY_RUN === "true") {
    // Allow CI pipelines to safely test the agent without pushing anything.
    raw.sync = { ...(raw.sync ?? {}), dryRun: true }
  }

  // --provider CLI flag: overrides config.models.provider
  if (process.env._CLI_PROVIDER) {
    raw.models = { ...(raw.models ?? {}), provider: process.env._CLI_PROVIDER }
  }

  // --api-key CLI flag: overrides config.models.apiKey
  if (process.env._CLI_API_KEY) {
    raw.models = { ...(raw.models ?? {}), apiKey: process.env._CLI_API_KEY }
  }

  // Validate and apply defaults.  SyncConfigSchema.parse() throws on invalid input.
  return SyncConfigSchema.parse(raw)
}
```

### `src/config/provider.ts`

**Exports:** resolveApiKey

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file provider.ts
 *
 * Provider configuration and API key resolution for the Backport Agent.
 * Handles the resolution of API keys from multiple sources with proper fallback.
 */
import type { SyncConfig } from "./schema.js";

/**
 * Resolves the API key for the LLM provider from the agent config.
 *
 * Resolution order:
 *  1. `_CLI_API_KEY` env var (set by the `--api-key` CLI flag).
 *  2. `config.models.apiKey` literal value (no `$` prefix).
 *  3. `config.models.apiKey` env-var reference: `"$ENV_VAR"` → `process.env[ENV_VAR]`.
 *  4. Implicit convention: `{PROVIDER_UPPER}_API_KEY` env var
 *     (e.g. `ANTHROPIC_API_KEY` for provider `"anthropic"`).
 *  5. `undefined` — the SDK will attempt its own credential discovery.
 */
export function resolveApiKey(config: SyncConfig): string | undefined {
  // CLI flag takes highest priority
  if (process.env._CLI_API_KEY) return process.env._CLI_API_KEY
  const { provider, apiKey } = config.models
  if (apiKey !== undefined) {
    return apiKey.startsWith("$") ? process.env[apiKey.slice(1)] : apiKey
  }
  const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`
  return process.env[envKey]
}
```

### `src/config/schema.ts`

**Exports:** SyncConfigSchema, SyncConfig

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file config/schema.ts
 *
 * Zod schema for the agent's main configuration file (config.json).
 * All fields are validated and typed at load time via `SyncConfigSchema.parse()`.
 *
 * The top-level object is divided into five sections:
 *  - `upstream`   – coordinates of the original repository being tracked
 *  - `fork`       – coordinates of the customised fork maintained by this agent
 *  - `workingDir` – filesystem location of the local checkout
 *  - `auth`       – git authentication (SSH key or HTTP bearer token)
 *  - `sync`       – behavioural knobs (commit limits, dry-run mode, branch names…)
 *  - `customizations` – inline or external customizations manifest (optional)
 *  - `models`     – LLM model identifiers used for cheap vs. powerful inference
 *  - `validation` – shell commands executed after cherry-picking, grouped by risk level
 */

import { z } from "zod"

/**
 * Full Zod validation schema for the backport-agent configuration.
 *
 * All nested objects have sensible defaults so that a minimal config.json only
 * needs to specify `upstream`, `fork`, and `workingDir`.
 *
 * **Important — Zod v4 `.default()` behaviour:**
 * When an entire sub-object is optional, we use `.default(() => ({} as any))`.
 * The factory form `() => value` is required by Zod v4 (unlike v3's plain value form).
 * The `as any` cast is intentional: each individual field already carries its own
 * `.default(…)`, so Zod will fill in all missing keys automatically; the outer
 * `{}` is just an empty trigger that lets the field-level defaults take effect.
 */
export const SyncConfigSchema = z.object({
  /**
   * Coordinates of the upstream (canonical) repository.
   * The agent fetches from this remote and picks commits out of it.
   */
  upstream: z.object({
    /** GitHub repository in `owner/repo` format, e.g. `"cline/cline"`. */
    repo: z.string().describe("owner/repo of the upstream repository"),
    /**
     * Full git URL for the upstream remote, e.g. `"git@github.com:org/repo.git"` (SSH)
     * or `"https://github.com/org/repo.git"` (HTTPS).
     * Required when the working directory does not yet exist (for auto-clone setup).
     * Supports any git hosting provider, not just GitHub.
     */
    url: z.string().optional().describe("Full git URL (SSH or HTTPS) for the upstream remote"),
    /** Branch on the upstream repo that the agent tracks, e.g. `"main"`. */
    branch: z.string().describe("Upstream branch to sync from"),
    /** Local git remote name pointing to the upstream repo. Defaults to `"upstream"`. */
    remote: z.string().default("upstream").describe("Git remote name for upstream"),
  }),

  /**
   * Coordinates of the fork (customised) repository.
   * This is where new sync branches are pushed and PRs are opened.
   */
  fork: z.object({
    /** GitHub repository in `owner/repo` format, e.g. `"TEA-ching/cline"`. */
    repo: z.string().describe("owner/repo of the fork"),
    /**
     * Full git URL for cloning the fork, e.g. `"git@github.com:myuser/repo.git"` (SSH)
     * or `"https://github.com/myuser/repo.git"` (HTTPS).
     * If the working directory does not exist the agent will clone this URL automatically.
     * Supports any git hosting provider, not just GitHub.
     */
    url: z.string().optional().describe("Full git URL (SSH or HTTPS) used to clone the fork"),
    /** Target branch in the fork that sync commits are based on, e.g. `"main"`. */
    branch: z.string().describe("Fork branch to sync into"),
    /** Local git remote name pointing to the fork. Defaults to `"origin"`. */
    remote: z.string().default("origin").describe("Git remote name for the fork"),
  }),

  /**
   * Absolute filesystem path to the local git clone of the fork.
   * All git operations are executed with this path as the working directory.
   * Example: `"/home/ci/repos/my-fork"`.
   * If the directory does not exist and `fork.url` is set, the agent will
   * clone the fork automatically on startup.
   */
  workingDir: z.string().describe("Absolute path to the local clone of the fork"),

  /**
   * Git authentication credentials.
   *
   * Exactly one of `sshKeyPath` or `githubToken` should be set:
   *  - `sshKeyPath`   — path to an SSH private key; sets `GIT_SSH_COMMAND` for all git calls.
   *    Supports `~` expansion.  Example: `"~/.ssh/id_ed25519"`.
   *  - `githubToken`  — bearer token for HTTPS remotes (GitHub PAT, GitLab token, etc.);
   *    injected via `http.extraHeader`.  Works with any git hosting provider.
   *    For security, prefer referencing an environment variable with the `$VAR` syntax
   *    (e.g. `"$GITHUB_TOKEN"`) instead of embedding the raw token.  If omitted, the
   *    agent falls back to the `GITHUB_TOKEN` environment variable automatically.
   *
   * Both fields are optional — omit this section if git is already authenticated
   * through the system SSH agent or a credential helper.
   */
  auth: z
    .object({
      /**
       * Absolute (or `~`-prefixed) path to the SSH private key.
       * Example: `"~/.ssh/id_ed25519"` or `"/home/ci/.ssh/deploy_key"`.
       */
      sshKeyPath: z.string().optional().describe("Path to the SSH private key (supports ~ expansion)"),
      /**
       * Bearer token for HTTPS authentication.
       * Prefix with `$` to read from an environment variable at runtime
       * (e.g. `"$GITHUB_TOKEN"`), which avoids storing the secret in config.json.
       */
      githubToken: z.string().optional().describe(
        "HTTP bearer token; use \"$ENV_VAR\" syntax to read from an environment variable"
      ),
    })
    .default(() => ({} as any)),

  /**
   * Runtime behaviour settings for the sync loop.
   * All fields have defaults, so this entire section is optional in config.json.
   */
  sync: z
    .object({
      /**
       * Maximum number of agent loop iterations per run.
       * Each iteration is one model turn (potentially invoking several tools in parallel).
       * Increase this value for large repos or runs with many conflict resolutions.
       * Defaults to 200.
       */
      maxIterations: z.number().int().positive().default(200),
      /** Maximum number of upstream commits to process in a single agent run. Defaults to 5. */
      maxCommitsPerRun: z.number().int().positive().default(5),
      /**
       * Input token threshold at which the agent injects a "wrap up now" message, instructing
       * it to call generate_report immediately with work done so far.
       * Set this below the model's context window minus a safe response budget.
       * For devstral-medium-latest (262k limit) the default of 220_000 leaves ~42k for the
       * final response + tool results.
       * A hard abort fires at min(maxContextTokens × 1.15, 260_000) to prevent the fatal
       * HTTP 400 that occurs when the prompt exceeds the model limit.
       * Defaults to 220_000.
       */
      maxContextTokens: z.number().int().positive().default(220_000),
      /**
       * Input token count at which `prepareTurn` triggers automatic context compaction.
       * The compaction hook serializes the conversation and asks a large-context summarizer
       * model to distill it into a compact progress summary, resetting the in-context history
       * to ~15k tokens so the run can continue processing remaining commits.
       * Set below `maxContextTokens`. Defaults to 180_000.
       */
      compactionThreshold: z.number().int().positive().default(180_000),
      /**
       * Depth used when first fetching remote refs.
       * Shallow enough to be fast; `ensureMergeBase` will deepen if necessary. Defaults to 200.
       */
      initialFetchDepth: z.number().int().positive().default(200),
      /**
       * Absolute upper bound for history depth when searching for a merge-base.
       * If the merge-base is not found within this depth, a full `--unshallow` fetch is attempted.
       * Defaults to 4000.
       */
      maxFetchDepth: z.number().int().positive().default(4000),
      /**
       * Number of commits to cherry-pick before pausing for human review.
       * Smaller batches reduce blast radius if something goes wrong. Defaults to 5.
       */
      batchSize: z.number().int().positive().default(5),
      /**
       * When true, the agent runs all analysis steps but skips all write operations
       * (no cherry-picks, no branch pushes, no PR creation). Defaults to false.
       * Can also be enabled at runtime via the `DRY_RUN=true` environment variable.
       */
      dryRun: z.boolean().default(false),
      /** When true, the agent opens a draft PR after pushing the sync branch. Defaults to true. */
      createPullRequest: z.boolean().default(true),
      /**
       * Prefix used when naming the auto-generated sync branch.
       * The final branch name is `<branchPrefix><upstreamBranch>-<YYYY-MM-DD>`.
       * Defaults to `"sync/upstream-"`.
       */
      branchPrefix: z.string().default("sync/upstream-"),

      /**
       * Heuristic detection of manually-applied backports by PR number.
       *
       * When enabled, `list_candidate_commits` will also mark an upstream commit
       * as already applied if a fork commit references the same PR number **and**
       * the two subjects exceed `minSubjectSimilarity` (Jaccard word-token score, 0–1).
       *
       * Use this when backports are sometimes applied manually without
       * `git cherry-pick -x`, which would otherwise leave them unlisted by the
       * standard `git cherry` + subject-match detection.
       *
       * **Disabled by default** — enable only when your team consistently includes
       * the upstream PR number in manual backport commit messages.
       */
      prNumberMatching: z
        .object({
          /** Enable PR-number-based duplicate detection. Defaults to `false`. */
          enabled: z.boolean().default(false),
          /**
           * Minimum Jaccard word-token similarity (0–1) between the upstream subject
           * and a fork subject that shares the same PR number.
           * Lower → more permissive (risk of false positives).
           * Higher → stricter (may miss heavily reworded manual backports).
           * Defaults to `0.4`.
           */
          minSubjectSimilarity: z.number().min(0).max(1).default(0.4),
        })
        .default(() => ({ enabled: false, minSubjectSimilarity: 0.4 })),

      /**
       * Glob and regex patterns matched against commit subjects.  Any upstream
       * commit whose subject matches at least one pattern is silently excluded from
       * the candidate list without being processed.
       *
       * Patterns are tested as JavaScript regular expressions (case-insensitive).
       * Examples:
       *  - `"^docs:"` — skip all commits that start with "docs:"
       *  - `"^chore: release"` — skip automated release commits
       *  - `"^revert "` — skip revert commits (they are often re-applied later)
       *
       * Defaults to `[]` (nothing skipped).
       */
      skipCommits: z
        .array(z.string())
        .default([])
        .describe("Regex patterns (case-insensitive) matched against commit subjects — matching commits are excluded"),

      /**
       * When `true`, the agent merges the sync PR via the GitHub API after
       * `run_validation` passes and no commit-blocked errors remain.
       * Requires `GITHUB_TOKEN` with `pull_requests: write` permission.
       * Defaults to `false`.
       */
      autoMergeOnSuccess: z
        .boolean()
        .default(false)
        .describe("Auto-merge the sync PR when all commits were applied and validation passed"),

      /**
       * GitHub merge strategy to use when `autoMergeOnSuccess` is enabled.
       * Defaults to `"squash"`.
       */
      autoMergeMethod: z
        .enum(["squash", "merge", "rebase"])
        .default("squash")
        .describe("GitHub merge method for auto-merge: squash | merge | rebase"),

      /**
       * When `true`, the sync branch is deleted via the GitHub API after a
       * successful auto-merge.  Defaults to `true`.
       */
      autoMergeDeleteBranch: z
        .boolean()
        .default(true)
        .describe("Delete the sync branch after a successful auto-merge"),

      /**
       * Maximum number of characters returned per version (forkVersion / upstreamVersion /
       * withMarkers) by the `get_conflict_context` tool.
       *
       * For large auto-generated files (e.g. model catalogs, lock files) returning the full
       * content of all three versions can exceed the model's context window in a single tool
       * result.  When any version exceeds this limit, `get_conflict_context` extracts only the
       * conflict-marker regions (with surrounding context lines) from `withMarkers`, and the
       * corresponding line ranges from `forkVersion` / `upstreamVersion`, falling back to a
       * head-truncation if line mapping is impractical.
       *
       * Set to a higher value if the agent frequently lacks enough context to resolve conflicts
       * correctly; lower it if context-window overflows persist.
       * Defaults to `60_000` (~15k tokens per version, ~45k total for all three).
       */
      maxConflictContextChars: z
        .number()
        .int()
        .positive()
        .default(60_000)
        .describe("Max chars per version returned by get_conflict_context (prevents context-window overflow for large files)"),
    })
    // Allow omitting the entire sync block in config.json; each field has its own default.
    .default(() => ({} as any)),

  /**
   * LLM provider and model identifiers used by the agent.
   * Use a cheap/fast model for high-volume triage and a more powerful one for
   * conflict resolution where reasoning quality matters most.
   *
   * The `provider` field identifies which LLM provider to use (e.g. `"anthropic"`,
   * `"openai"`, `"mistral"`, `"keypoollive"`).  If omitted, the agent falls back to
   * looking up `{PROVIDER}_API_KEY` from the environment.
   *
   * The `apiKey` field accepts a literal value or an env-var reference
   * using the `"$ENV_VAR_NAME"` syntax (e.g. `"$ANTHROPIC_API_KEY"`).
   * If omitted, the agent automatically looks up `{PROVIDER_UPPER}_API_KEY` from
   * the environment (e.g. `ANTHROPIC_API_KEY` for provider `"anthropic"`).
   * The special value `"auto"` is accepted by the `keypoollive` provider to
   * trigger vault-based key resolution at runtime.
   */
  models: z
    .object({
      /**
       * LLM provider ID to use for all agent calls.
       * Examples: `"anthropic"`, `"openai"`, `"mistral"`, `"keypoollive"`.
       * Required — no default is provided so that misconfigured runs fail fast.
       */
      provider: z.string().describe("LLM provider ID (e.g. \"anthropic\", \"openai\", \"keypoollive\")"),
      /**
       * API key for the provider.  Use `"$ENV_VAR_NAME"` to read from an env var
       * at runtime (e.g. `"$ANTHROPIC_API_KEY"`).  Use `"auto"` for providers
       * that resolve credentials internally (keypoollive vault).
       * If omitted, the agent looks up `{PROVIDER_UPPER}_API_KEY` from the
       * process environment automatically.
       */
      apiKey: z
        .string()
        .optional()
        .describe("API key or \"$ENV_VAR\" reference; omit to auto-detect from environment"),
      /**
       * Model used for fast, inexpensive tasks such as summarising diffs and
       * classifying risk alongside the deterministic rule engine.
       * Defaults to `"mistral/devstral-latest"`.
       */
      fast: z.string().default("mistral/devstral-latest").describe("Low-cost model for summaries and risk triage"),
      /**
       * Model used as first attempt for conflict resolution — optimised for code tasks.
       * Falls back to `models.powerful` if this call fails.
       * Defaults to `"mistral/devstral-latest"`.
       */
      specialist: z
        .string()
        .default("mistral/devstral-latest")
        .describe("Code-specialist model for conflict resolution (first attempt)"),
      /**
       * Model used for complex conflict resolution that demands deeper reasoning.
       * Invoked as a fallback when `models.specialist` fails.
       * Defaults to `"mistral/magistral-medium-latest"`.
       */
      powerful: z
        .string()
        .default("mistral/magistral-medium-latest")
        .describe("High-capability model for conflict resolution (fallback)"),
      /**
       * Optional model used exclusively for context compaction (the `prepareTurn` hook).
       * Must have a large enough context window to ingest the full conversation transcript
       * (~200k tokens) — Gemini 2.5 Flash (1M context) is the recommended choice.
       * If absent, falls back to `models.specialist` with the same provider.
       *
       * With keypoollive vault:
       *   { "provider": "keypoollive", "modelId": "gemini/gemini-2.5-flash-preview" }
       * With direct Gemini API key:
       *   { "provider": "gemini", "modelId": "gemini-2.5-flash-preview", "apiKey": "$GEMINI_API_KEY" }
       */
      summarizer: z
        .object({
          provider: z.string(),
          modelId: z.string(),
          apiKey: z.string().optional(),
        })
        .optional(),
    })
    // Allow omitting the entire models block; individual fields carry defaults.
    .default(() => ({} as any)),

  /**
   * AI quality guardrails and opt-in quality features.
   *
   * Controls confidence thresholds, post-processing guards applied to every AI
   * tool output, and optional features that trade higher cost / latency for
   * improved reliability.
   */
  ai: z
    .object({
      /**
       * Minimum confidence level required to auto-apply a conflict resolution
       * produced by `resolve_conflict_with_ai` without requesting human review.
       *
       * - `"medium"` (default): auto-apply when confidence is "medium" or "high".
       * - `"high"`:             only auto-apply when the model is highly confident;
       *                          all "medium" resolutions are routed to human review.
       */
      minAutoApplyConfidence: z
        .enum(["high", "medium"])
        .default("medium")
        .describe("Minimum AI confidence to auto-apply conflict resolutions without human review"),

      /**
       * When `true`, any commit where `analyze_commit_for_backport` returns at least
       * one `semanticRiskFactor` is automatically flagged for human review, regardless
       * of the model's `recommendation` field.
       * Defaults to `false`.
       */
      requireReviewOnSemanticRisk: z
        .boolean()
        .default(false)
        .describe("Flag commits with semantic risk factors for human review even if AI recommends apply"),

      /**
       * When `true`, `resolve_conflict_with_ai` runs a second independent call using
       * `models.powerful` and compares the two resolved contents.  If the outputs
       * diverge significantly (line-level Dice similarity below `conflictConsensusThreshold`),
       * the confidence is downgraded to `"low"` to trigger human review.
       *
       * **Disabled by default** — enabling it doubles the token cost and latency of
       * every conflict-resolution call.  Enable for repositories where an incorrect
       * auto-resolution would have a large blast radius.
       */
      enableConflictConsensus: z
        .boolean()
        .default(false)
        .describe("Run a second independent model call to validate conflict resolutions (doubles cost/latency)"),

      /**
       * Line-similarity threshold (Dice coefficient, 0–1) used when
       * `enableConflictConsensus` is `true`.  Two resolutions whose trimmed-line
       * similarity falls below this value are considered divergent and trigger a
       * confidence downgrade to `"low"`.
       * Defaults to `0.7` (70 % of unique trimmed lines must match).
       */
      conflictConsensusThreshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.7)
        .describe("Minimum Dice line-similarity (0–1) for consensus; below threshold → confidence=low"),

      /**
       * When `true`, `check_customization_compatibility` reads the actual content of
       * files matching each customization pattern and includes up to 2 000-character
       * snippets per file in the LLM prompt.  This gives the model concrete code to
       * reason about rather than purely abstract descriptions.
       * Defaults to `true`.
       *
       * Set to `false` to reduce prompt token consumption for repositories with very
       * large customization files.
       */
      enrichCustomizationContext: z
        .boolean()
        .default(true)
        .describe("Include actual file content snippets in check_customization_compatibility prompts"),

      /**
       * Controls how `reconcile_ai_assessments` merges the outputs of
       * `analyze_commit_for_backport` and `check_customization_compatibility`.
       *
       * - `"conservative"` (default): always take the more restrictive recommendation.
       *   Safe but may over-escalate when one model is systematically cautious.
       * - `"optimistic"`: always take the more permissive recommendation.
       *   Faster throughput; only appropriate when false-positive escalations are a
       *   larger problem than missed conflicts.
       * - `"weighted"`: weighted blend of the two severity scores (see `analyzeWeight`).
       *   Balances the two models; requires tuning.
       */
      reconciliationMode: z
        .enum(["conservative", "optimistic", "weighted"])
        .default("conservative")
        .describe("How to reconcile analyze vs. compatibility recommendations: conservative | optimistic | weighted"),

      /**
       * Weight given to `analyze_commit_for_backport`'s severity score in weighted
       * reconciliation mode.  Must be in the range [0, 1].
       * The compatibility check receives weight `1 - analyzeWeight`.
       * Only used when `reconciliationMode` is `"weighted"`.
       * Defaults to `0.5` (equal weight).
       */
      analyzeWeight: z
        .number()
        .min(0)
        .max(1)
        .default(0.5)
        .describe("Weight for analyze_commit severity in weighted mode (0=full compat weight, 1=full analyze weight)"),

      /**
       * Diff size threshold (in characters) above which AI analysis tools
       * route to `models.powerful` instead of `models.fast`.
       * Large diffs (e.g. bun.lock releases) may exceed the fast model's
       * reasoning quality; a powerful model handles them more accurately and
       * may also have fewer rate-limit issues due to a different quota pool.
       * Defaults to `20000` (~5k tokens).
       */
      largeContextThreshold: z
        .number()
        .int()
        .positive()
        .default(20_000)
        .describe("Diff size (chars) above which AI analysis uses models.powerful instead of models.fast"),
    })
    .default(() => ({} as any)),

  /**
   * Deterministic merge-strategy overrides by file path.
   *
   * Each entry is either a glob pattern (matched via `minimatch`) or a regex
   * literal in the form `/pattern/flags` (e.g. `"/^sdk\\/.*\.lock$/i"`).
   * Patterns are tested against the repo-relative file path.
   *
   * When a conflicted file matches:
   *  - `ours`   → the fork version (HEAD) is used as-is; AI resolution is skipped.
   *  - `theirs` → the upstream version (CHERRY_PICK_HEAD) is used as-is; AI resolution is skipped.
   *
   * `theirs` is checked first; if a file matches both, `theirs` wins.
   */
  resolve: z
    .object({
      /**
       * Patterns for files where the fork version must always be kept.
       * Useful for lock files, generated assets, or files maintained exclusively in the fork.
       */
      ours: z.array(z.string()).default([]).describe("Glob/regex patterns — always keep fork version on conflict"),
      /**
       * Patterns for files where the upstream version must always be taken.
       * Useful for changelogs, upstream-owned config files, or generated files
       * that must not carry fork modifications.
       */
      theirs: z.array(z.string()).default([]).describe("Glob/regex patterns — always take upstream version on conflict"),
    })
    .default(() => ({} as any)),

  /**
   * Customizations manifest source.
   *
   * Accepts three forms:
   *  - `string` starting with `http://` or `https://` → fetched at runtime.
   *  - `string` (any other value) → treated as a local filesystem path.
   *  - `object` → the manifest is embedded directly in config.json (JSON equivalent
   *    of the YAML structure expected by `CustomizationsSchema`).
   *
   * When omitted the loader falls back to the `BACKPORT_CUSTOMIZATIONS` env var,
   * then to `./customizations.yaml` in the current working directory.
   */
  customizations: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .describe("Path, URL, or inline object for the customizations manifest"),

  /**
   * Report output settings.
   */
  report: z
    .object({
      /**
       * Filesystem directory where the detailed Markdown run report is written.
       * The file name is `report.<timestamp>.md`.
       * Defaults to the current working directory (`.`).
       */
      destination: z.string().default(".").describe("Directory where detailed run reports are written"),
    })
    .default(() => ({} as any)),

  /**
   * Shell command suites executed after cherry-picking, indexed by risk level.
   * Commands must match the allowlist in `validation/commands.ts` or they will
   * be blocked at execution time.
   */
  validation: z
    .object({
      /**
       * Commands run for low-risk commits (no customisation or build-critical files touched).
       * Defaults to `["npm run typecheck"]`.
       */
      low: z.array(z.string()).default(["npm run typecheck"]),
      /**
       * Commands run for medium-risk commits (shared/services code changed).
       * Defaults to typecheck + unit tests.
       */
      medium: z.array(z.string()).default(["npm run typecheck", "npm run test:unit"]),
      /**
       * Commands run for high-risk commits (customisation zones, build files, lock files…).
       * Defaults to typecheck + unit tests + full build.
       */
      high: z.array(z.string()).default(["npm run typecheck", "npm run test:unit", "npm run build"]),
      /**
       * Comprehensive end-to-end build commands run once at the end of a sync run,
       * after per-commit validation.  Intended for full build/package steps that are
       * too expensive to repeat after each commit but must pass before the PR is created.
       *
       * Each entry is a shell command executed via `bash -c` with `workingDir` as cwd,
       * so compound commands (`cd apps/vscode && bun install`), `pushd`/`popd`, etc.
       * are all supported.
       *
       * Defaults to `[]` (disabled).
       */
      final: z.array(z.string()).default([]),
    })
    // Allow omitting the entire validation block; individual fields carry defaults.
    .default(() => ({} as any)),
})

/**
 * TypeScript type derived directly from `SyncConfigSchema`.
 * Use this type throughout the codebase instead of repeating the inline shape.
 */
export type SyncConfig = z.infer<typeof SyncConfigSchema>
```

### `src/customizations/loader.ts`

**Exports:** loadCustomizations, getCustomizationPaths

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file customizations/loader.ts
 *
 * Loads and validates the customizations manifest from multiple sources.
 *
 * Resolution order for the manifest (first match wins):
 *  1. Explicit `source` argument passed by the caller.
 *     - `string` starting with `http://` or `https://` → fetched via HTTP GET.
 *     - `string` (other) → read from the local filesystem.
 *     - `object` → used directly as the parsed manifest (JSON/inline form).
 *  2. The `BACKPORT_CUSTOMIZATIONS` environment variable (file path).
 *  3. `customizations.yaml` in the current working directory.
 *
 * The resolved value is parsed with `js-yaml` when it comes from a string/URL,
 * then validated against `CustomizationsSchema` via Zod.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import yaml from "js-yaml"
import { CustomizationsSchema, type Customizations } from "./schema.js"

/**
 * Read, parse, and validate the customizations manifest.
 *
 * @param source - Optional source: a file path, an HTTP(S) URL, or an inline object.
 *                 Falls back to `BACKPORT_CUSTOMIZATIONS` env var, then `./customizations.yaml`.
 * @returns A fully validated `Customizations` object.
 * @throws {Error} If the file/URL cannot be read.
 * @throws {ZodError} If the structure does not satisfy `CustomizationsSchema`.
 */
export async function loadCustomizations(source?: string | Record<string, unknown>): Promise<Customizations> {
  // --- Inline object: already parsed, validate directly ---
  if (source !== undefined && typeof source === "object") {
    return CustomizationsSchema.parse(source)
  }

  // --- Resolve string source ---
  const strSource =
    source ?? process.env.BACKPORT_CUSTOMIZATIONS ?? resolve(process.cwd(), "customizations.yaml")

  let raw: unknown

  if (typeof strSource === "string" && (strSource.startsWith("http://") || strSource.startsWith("https://"))) {
    // URL: fetch via HTTP GET
    const response = await fetch(strSource)
    if (!response.ok) {
      throw new Error(`Failed to fetch customizations from ${strSource}: HTTP ${response.status} ${response.statusText}`)
    }
    const text = await response.text()
    raw = yaml.load(text)
  } else {
    // Local file path
    raw = yaml.load(readFileSync(strSource as string, "utf-8"))
  }

  return CustomizationsSchema.parse(raw)
}

/**
 * Flatten all glob patterns from every customization entry into a single array.
 *
 * Useful as a quick pre-filter: if a changed file matches any of these patterns
 * the caller knows it needs deeper per-entry inspection.
 *
 * @param customizations - Validated customizations manifest.
 * @returns Deduplicated flat array of all glob patterns across all entries.
 */
export function getCustomizationPaths(customizations: Customizations): string[] {
  // flatMap collapses the nested arrays from each entry's `paths` field.
  return customizations.customizations.flatMap((c) => c.paths)
}
```

### `src/customizations/schema.ts`

**Exports:** CustomizationEntrySchema, CustomizationsSchema, CustomizationEntry, Customizations

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file customizations/schema.ts
 *
 * Zod schema for the agent's customizations manifest (customizations.yaml).
 *
 * Each "customization entry" describes a deliberate deviation from upstream:
 * which file paths it covers, what invariants must remain intact after a sync,
 * and optional shell commands that can verify the customization is still working.
 *
 * The agent uses this manifest to:
 *  1. Detect when an upstream commit touches a customization zone (risk classification).
 *  2. Guide conflict resolution — the LLM knows which files carry fork-specific logic.
 *  3. Produce human-readable PR comments that explain why certain files need review.
 */

import { z } from "zod"

/**
 * Schema for a single customization entry in the manifest.
 *
 * Example YAML entry:
 * ```yaml
 * - id: keypoollive-provider-vscode
 *   description: "Registers the keypoollive LLM provider inside the VS Code extension"
 *   paths:
 *     - src/api/providers/keypoollive.ts
 *     - src/shared/providers/providers.json
 *   invariants:
 *     - "keypoollive must remain listed in providers.json"
 *   testCommands:
 *     - "npm run typecheck"
 * ```
 */
export const CustomizationEntrySchema = z.object({
  /**
   * Short machine-readable identifier for this customization, e.g. `"keypoollive-provider-vscode"`.
   * Used in risk reports and decision logs to unambiguously reference the entry.
   */
  id: z.string(),

  /**
   * Human-readable description of what this customization does and why it exists.
   * Surfaced in PR comments and agent decision logs.
   */
  description: z.string(),

  /**
   * Glob patterns (relative to the repository root) that cover the files owned
   * by this customization.  Any upstream commit touching one of these paths will
   * be classified as high risk.
   *
   * Standard minimatch syntax is supported, e.g. `"src/api/providers/keypoollive/**"`.
   */
  paths: z.array(z.string()).describe("Glob patterns relative to repo root"),

  /**
   * Ordered list of invariants that must remain true after every sync.
   * The agent checks these conceptually during conflict resolution and includes
   * them in the PR body so human reviewers know what to verify.
   *
   * Example: `"The SCTG_KEY_VAULT_URL constant must not be removed."`
   */
  invariants: z.array(z.string()).describe("Human-readable invariants that must remain true after sync"),

  /**
   * Optional shell commands to run in order to verify this specific customization
   * is still intact after a sync.  These are appended to the validation suite when
   * the commit risk level is "high" and this customization is affected.
   *
   * Commands must still match the global allowlist in `validation/commands.ts`.
   */
  testCommands: z.array(z.string()).optional().describe("Commands to verify this customization still works"),
})

/**
 * Schema for the entire customizations manifest file.
 * The top-level key `customizations` holds the array of entries.
 */
export const CustomizationsSchema = z.object({
  /** Array of all known fork customizations. May be empty if the fork has no deviations. */
  customizations: z.array(CustomizationEntrySchema),
})

/**
 * TypeScript type for a single customization entry, inferred from `CustomizationEntrySchema`.
 */
export type CustomizationEntry = z.infer<typeof CustomizationEntrySchema>

/**
 * TypeScript type for the full customizations manifest, inferred from `CustomizationsSchema`.
 */
export type Customizations = z.infer<typeof CustomizationsSchema>
```

### `src/git/git-client.ts`

**Exports:** git, CandidateCommit, ensureMergeBase, PrNumberMatchingOptions, subjectSimilarity, listCandidateCommits, getCommitChangedFiles, getCommitDiff, createSyncBranch, cherryPick, abortCherryPick, getFileAtRef, readWorkingFile, writeAndStageFile, continueCherryPick, pushBranch, fetchRemotes

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file git/git-client.ts
 *
 * Low-level git operations used by the backport agent.
 *
 * Design principles:
 *  - **No shell interpolation** — all git invocations use `execFileSync` with an
 *    explicit argument array.  User-supplied strings (SHAs, branch names, file
 *    paths) are always passed as separate array items, never concatenated into a
 *    shell command string.  This prevents command-injection vulnerabilities.
 *  - **Synchronous I/O** — the agent runs a single-threaded, sequential workflow;
 *    async/await overhead would add complexity without benefit.
 *  - **Minimal surface** — each function does exactly one git operation.  Higher-
 *    level orchestration lives in `git-tools.ts` (agent tool wrappers).
 */

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

/**
 * Executes a git command in the given working directory using `execFileSync`.
 *
 * All standard streams are piped so that stdout and stderr are captured rather
 * than printed to the terminal.  The return value is the trimmed stdout string.
 *
 * **Security note:** arguments must always be provided as an array — never as a
 * pre-joined string — to prevent shell injection.
 *
 * @param args - Git sub-command and its arguments, e.g. `["cherry", "-v", "HEAD"]`.
 * @param cwd  - Absolute path to the repository working directory.
 * @returns Trimmed stdout output of the git command.
 * @throws If the git process exits with a non-zero status (e.g. merge conflict).
 */
export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim()
}

/**
 * Represents a single upstream commit that the agent is considering for cherry-picking.
 */
export type CandidateCommit = {
  /** Full 40-character SHA of the upstream commit. */
  sha: string
  /** First line of the commit message (subject). */
  subject: string
  /**
   * `true` when `git cherry` determined that an equivalent patch is already
   * present in the fork branch (prefix `-` in cherry output).
   * Such commits are reported but skipped without cherry-picking.
   */
  alreadyApplied: boolean
}

/**
 * Ensures the local git history is deep enough to compute the merge-base between
 * the upstream branch and the fork branch.
 *
 * Many CI environments start with a shallow clone (`--depth=1`).  This function
 * progressively deepens the clone using exponential doubling, which requires fewer
 * network round-trips than the previous fixed ladder while also avoiding the
 * systematic overfetch that occurred when the merge-base fell just above a step.
 *
 * Algorithm:
 *  1. Try `git merge-base` at the current history depth.
 *  2. If it fails, double the fetch depth and retry.  Only the *delta* is passed to
 *     `--deepen` so that each round adds the minimum required commits.
 *  3. If even `maxDepth` is insufficient, fall back to `--unshallow`.
 *
 * @param cwd         - Absolute path to the repository working directory.
 * @param upstreamRef - Full ref for the upstream branch, e.g. `"upstream/main"`.
 * @param forkRef     - Full ref for the fork branch, e.g. `"origin/main"`.
 * @param maxDepth    - Depth ceiling before attempting a full unshallow fetch.
 *                      Defaults to 4000 (matches `sync.maxFetchDepth` default).
 * @returns The SHA of the common ancestor commit (the merge-base).
 * @throws If the merge-base cannot be determined even after a full fetch.
 */
export function ensureMergeBase(
  cwd: string,
  upstreamRef: string,
  forkRef: string,
  maxDepth = 4000,
): string {
  // Try at the current (potentially already-deep) history first — zero-cost if the
  // clone already has enough history.
  try {
    return git(["merge-base", upstreamRef, forkRef], cwd)
  } catch {
    // Need to deepen; fall through to the exponential doubling loop.
  }

  // Exponential doubling: start at 200, double each round, stop at maxDepth.
  // Tracks the depth already fetched so --deepen receives only the increment,
  // avoiding redundant refetching of already-present commits.
  let currentDepth = 0
  let targetDepth = 200

  while (targetDepth <= maxDepth) {
    const delta = targetDepth - currentDepth
    git(["fetch", `--deepen=${delta}`], cwd)
    currentDepth = targetDepth

    try {
      return git(["merge-base", upstreamRef, forkRef], cwd)
    } catch {
      // Not deep enough yet; double and retry.
    }

    targetDepth = Math.min(targetDepth * 2, maxDepth)

    // Once we have already fetched to maxDepth and still failed, break to unshallow.
    if (currentDepth >= maxDepth) break
  }

  // Last resort: fetch the entire history and try once more.
  git(["fetch", "--unshallow"], cwd)
  return git(["merge-base", upstreamRef, forkRef], cwd)
}

/**
 * Options that control optional heuristic detection passes in
 * `listCandidateCommits`.
 */
export interface PrNumberMatchingOptions {
  /** Must be `true` to activate Signal 4. */
  enabled: boolean
  /**
   * Jaccard word-token similarity threshold (0–1).  An upstream commit is only
   * considered already applied when both the PR number matches **and** the
   * similarity between the upstream subject and the matching fork subject meets
   * this floor.  Prevents false positives from accidental PR number collisions.
   */
  minSubjectSimilarity: number
}

/**
 * Computes a Jaccard word-token similarity score (0–1) between two commit subjects.
 *
 * Both strings are lowercased, PR-number references (e.g. `(#11200)`,
 * `(cline#11200)`) are stripped, and the result is tokenised on non-word
 * boundaries.  Single-character tokens are discarded as noise.
 *
 * A score of `1.0` means both subjects share all the same meaningful words;
 * `0.0` means they share none.
 *
 * @example
 * subjectSimilarity(
 *   "Move `sdk/apps/` to `apps/` (#11200)",
 *   "feat(backport): Move sdk/apps/ to apps/ (cline#11200)",
 * ) // → ~0.67
 */
export function subjectSimilarity(a: string, b: string): number {
  const tokenize = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        // Strip PR / issue refs such as (#11200) or (cline#11200).
        .replace(/\([^)]*#\d+[^)]*\)/g, " ")
        // Strip common markdown / shell punctuation.
        .replace(/[`'"*()[\]{}/\\:]/g, " ")
        .split(/\W+/)
        .filter((t) => t.length > 1),
    )

  const tokA = tokenize(a)
  const tokB = tokenize(b)
  if (tokA.size === 0 && tokB.size === 0) return 1
  const intersection = [...tokA].filter((t) => tokB.has(t)).length
  const union = new Set([...tokA, ...tokB]).size
  return union === 0 ? 0 : intersection / union
}

/**
 * Lists all upstream commits that are not yet present in the fork branch.
 *
 * Uses `git cherry` which compares patch content (not just SHA) so that commits
 * that were already cherry-picked (and may have a different SHA in the fork) are
 * correctly identified as already applied.
 *
 * Output format of `git cherry -v <upstream> <fork>`:
 *  - Lines prefixed with `+` are **not** in the fork → candidates for cherry-pick.
 *  - Lines prefixed with `-` **are** equivalent in the fork → already applied.
 *
 * **Limitation of `git cherry`:** it compares patch IDs (a hash of the
 * normalised diff).  When a cherry-pick was modified during conflict resolution
 * the patch content changes, so the patch ID no longer matches and `git cherry`
 * incorrectly marks the commit as `+` even though it was already integrated.
 *
 * To compensate, a secondary detection pass cross-references the fork's commit
 * history on two additional signals:
 *  1. **Subject match** – the fork contains a commit with the exact same
 *     first-line subject as the upstream commit.
 *  2. **SHA reference** – the fork contains a commit whose message body
 *     includes a `cherry picked from commit <sha>` annotation (added
 *     automatically by `git cherry-pick -x`).
 *
 * An optional third signal can be activated via `prNumberMatching`:
 *  3. **PR number + similarity** – the fork contains a commit whose subject
 *     references the same upstream PR number (e.g. `(#11200)` → `(cline#11200)`)
 *     and whose word-token Jaccard similarity with the upstream subject meets
 *     `minSubjectSimilarity`.  Catches manual backports that were reworded but
 *     kept the PR number reference.  Disabled by default.
 *
 * @param cwd              - Absolute path to the repository working directory.
 * @param upstreamRef      - Full ref for the upstream branch, e.g. `"upstream/main"`.
 * @param forkRef          - Full ref for the fork branch, e.g. `"origin/main"`.
 * @param prNumberMatching - Optional Signal 4 options (disabled when omitted).
 * @returns Array of `CandidateCommit` objects, oldest-first.
 */
export function listCandidateCommits(
  cwd: string,
  upstreamRef: string,
  forkRef: string,
  prNumberMatching?: PrNumberMatchingOptions,
): CandidateCommit[] {
  // `git cherry -v <fork> <upstream>` lists commits reachable from <upstream>
  // but not equivalent in <fork>.  The `-v` flag adds the subject line.
  const cherryOutput = git(["cherry", "-v", forkRef, upstreamRef], cwd)

  // Empty output means upstream and fork are already in sync.
  if (!cherryOutput) return []

  const rawCandidates = cherryOutput.split("\n").map((line) => {
    // Each line: `<marker> <sha> <subject>` where marker is `+` or `-`.
    const marker = line[0]
    const rest = line.slice(2) // skip marker and space
    const spaceIdx = rest.indexOf(" ")
    const sha = rest.slice(0, spaceIdx)
    const subject = rest.slice(spaceIdx + 1)
    return {
      sha,
      subject,
      // `-` means an equivalent patch already exists in the fork.
      alreadyApplied: marker === "-",
    }
  })

  // Fast path: if git cherry already marked every commit as applied, skip the
  // secondary pass entirely.
  if (rawCandidates.every((c) => c.alreadyApplied)) return rawCandidates

  // Secondary detection pass — catches cherry-picks that were modified during
  // conflict resolution (different patch content breaks git cherry's comparison).
  // We scan the last FORK_LOG_DEPTH commits on the fork branch for two signals.
  const FORK_LOG_DEPTH = 5000

  // Signal 1: collect all first-line subjects from recent fork commits.
  const forkSubjects = new Set<string>()
  try {
    const subjectLog = git(["log", forkRef, "--format=%s", `--max-count=${FORK_LOG_DEPTH}`], cwd)
    for (const s of subjectLog.split("\n")) {
      const trimmed = s.trim()
      if (trimmed) forkSubjects.add(trimmed)
    }
  } catch {
    // Fork branch may not exist locally yet; ignore and fall back to git cherry only.
  }

// Signal 2: upstream SHA referenced inside a fork commit message body.
    // `git cherry-pick -x` appends "(cherry picked from commit <sha>)" automatically.
    const forkShaRefs = new Set<string>()
    try {
      const bodyLog = git(["log", forkRef, "--format=%B", `--max-count=${FORK_LOG_DEPTH}`], cwd)
      for (const m of bodyLog.matchAll(/cherry.picked from commit ([0-9a-f]{7,40})/gi)) {
        forkShaRefs.add(m[1].toLowerCase())
      }
    } catch {
      // Ignore — missing body log is non-fatal; subject matching still works.
    }

    // Signal 4 (optional): PR-number match with subject-similarity guard.
    // Build an index of PR numbers → fork subjects that reference them.
    // Only populated when prNumberMatching?.enabled is true.
    const forkPrIndex = new Map<number, string[]>()
    if (prNumberMatching?.enabled) {
      try {
        const subjectLog = git(["log", forkRef, "--format=%s", `--max-count=${FORK_LOG_DEPTH}`], cwd)
        for (const subj of subjectLog.split("\n")) {
          const trimmed = subj.trim()
          if (!trimmed) continue
          for (const m of trimmed.matchAll(/#(\d+)/g)) {
            const num = parseInt(m[1], 10)
            const bucket = forkPrIndex.get(num)
            if (bucket) bucket.push(trimmed)
            else forkPrIndex.set(num, [trimmed])
          }
        }
      } catch {
        // Non-fatal — fall back to the other three signals.
      }
    }

    return rawCandidates.map((c) => {
      if (c.alreadyApplied) return c

      // Signal 1: exact subject match.
      if (forkSubjects.has(c.subject)) return { ...c, alreadyApplied: true }

      // Signal 2: upstream SHA referenced inside a fork commit message.
      // A fork commit references this upstream SHA when one is a prefix of the
      // other (handles both abbreviated 7-char refs and full 40-char SHAs).
      const upSha = c.sha.toLowerCase()
      for (const ref of forkShaRefs) {
        if (upSha.startsWith(ref) || ref.startsWith(upSha)) {
          return { ...c, alreadyApplied: true }
        }
      }

      // Signal 4: PR number present in both subjects, similarity above threshold.
      if (prNumberMatching?.enabled) {
        const upPrMatch = c.subject.match(/#(\d+)/)
        if (upPrMatch) {
          const prNum = parseInt(upPrMatch[1], 10)
          const forkMatches = forkPrIndex.get(prNum)
          if (
            forkMatches?.some(
              (s) => subjectSimilarity(c.subject, s) >= prNumberMatching.minSubjectSimilarity,
            )
          ) {
            return { ...c, alreadyApplied: true }
          }
        }
      }

      return c
    })
  }

/**
 * Returns the list of file paths changed by a single commit, with status prefixes
 * for deletions and renames so that `classifyRisk` can detect them.
 *
 * Internally calls `git diff-tree --no-commit-id -r --name-status <sha>` which
 * lists each changed path together with its status letter (M, A, D, R, C…).
 *
 * The returned strings follow the convention expected by `classifyRisk`:
 *  - Regular changes (M, A, T, U, X…) → bare repo-relative path, e.g. `"src/foo.ts"`.
 *  - Deletions (D)                     → `"DELETE:src/foo.ts"`.
 *  - Renames / copies (R, C)           → `"RENAME:src/new.ts"` (new path used for
 *    risk matching) *plus* the old path as a bare entry so both sides are checked.
 *
 * @param cwd - Absolute path to the repository working directory.
 * @param sha - Full or abbreviated commit SHA.
 * @returns Array of repository-relative file paths changed by the commit,
 *          with `DELETE:` / `RENAME:` prefixes where applicable.
 *          Empty array if the commit has no file changes (e.g. an empty commit).
 */
export function getCommitChangedFiles(cwd: string, sha: string): string[] {
  const output = git(["diff-tree", "--no-commit-id", "-r", "--name-status", sha], cwd)
  if (!output) return []

  const files: string[] = []
  for (const line of output.split("\n").filter(Boolean)) {
    // Format: `<status>\t<path>` for M/A/D, `<status><score>\t<oldPath>\t<newPath>` for R/C.
    const parts = line.split("\t")
    const statusCode = parts[0][0]  // First character is the status letter.
    if (statusCode === "D") {
      files.push(`DELETE:${parts[1]}`)
    } else if (statusCode === "R" || statusCode === "C") {
      // Include the old path so patterns on the source side are also matched,
      // and the new path with a RENAME: prefix for risk classification.
      files.push(parts[1])                  // old path (bare)
      files.push(`RENAME:${parts[2]}`)      // new path with prefix
    } else {
      files.push(parts[1])
    }
  }
  return files
}

/**
 * Returns the full diff of a single commit, capped to `maxBytes` characters.
 *
 * The diff includes the commit stat summary (`--stat`) followed by the patch
 * (`--patch`).  Large diffs are truncated with a notice so that the LLM context
 * window is not exhausted by a single commit.
 *
 * @param cwd      - Absolute path to the repository working directory.
 * @param sha      - Full or abbreviated commit SHA.
 * @param maxBytes - Maximum number of characters to return.  Defaults to 32 000.
 * @returns Diff string, possibly truncated.
 */
export function getCommitDiff(cwd: string, sha: string, maxBytes = 32_000): string {
  const full = git(["show", "--stat", "--patch", sha], cwd)
  // Truncate and append a notice so the LLM knows the diff is incomplete.
  return full.length > maxBytes ? full.slice(0, maxBytes) + "\n... [truncated]" : full
}

/**
 * Creates a new sync branch from the tip of the fork branch.
 *
 * The branch is created locally; `pushBranch` must be called separately to
 * publish it to the remote.
 *
 * @param cwd        - Absolute path to the repository working directory.
 * @param branchName - Name for the new sync branch.
 * @param forkRef    - Full ref of the fork branch to branch off, e.g. `"origin/main"`.
 */
export function createSyncBranch(cwd: string, branchName: string, forkRef: string): void {
  // First check out the fork branch tip to set HEAD correctly.
  git(["checkout", forkRef], cwd)
  // Then create and switch to the new sync branch.
  git(["checkout", "-b", branchName], cwd)
}

/**
 * Attempts to cherry-pick a single upstream commit onto the current branch.
 *
 * The `-x` flag appends `(cherry picked from commit …)` to the commit message,
 * providing an audit trail in the fork's history.
 *
 * On conflict, the cherry-pick is intentionally left **in progress** rather than
 * aborted.  This allows the agent to inspect each conflicted file via
 * `getConflictContext`, resolve them, then call `continueCherryPick`.  If the
 * agent cannot resolve the conflicts, it should call `abortCherryPick` instead.
 *
 * @param cwd - Absolute path to the repository working directory.
 * @param sha - Full or abbreviated SHA of the commit to cherry-pick.
 * @returns An object with `success: true` if the cherry-pick applied cleanly,
 *          or `success: false` plus the list of conflicted file paths.
 */
export function cherryPick(cwd: string, sha: string): { success: boolean; conflictedFiles: string[] } {
  try {
    // -x appends a "cherry picked from" note to the commit message.
    git(["cherry-pick", "-x", sha], cwd)
    return { success: true, conflictedFiles: [] }
  } catch {
    // Git exits non-zero on conflict.  Collect the conflicting file paths.
    const status = git(["diff", "--name-only", "--diff-filter=U"], cwd)
    // U = unmerged (conflicted) files.
    const conflictedFiles = status ? status.split("\n").filter(Boolean) : []
    return { success: false, conflictedFiles }
  }
}

/**
 * Aborts a cherry-pick that is currently in progress.
 *
 * This resets the index and working tree to the state before `git cherry-pick`
 * was called.  It is safe to call even if no cherry-pick is in progress (the
 * error is swallowed silently).
 *
 * @param cwd - Absolute path to the repository working directory.
 */
export function abortCherryPick(cwd: string): void {
  try {
    git(["cherry-pick", "--abort"], cwd)
  } catch {
    // Ignore errors — git returns non-zero if there is no cherry-pick in progress,
    // which is a harmless edge case (e.g. called twice by mistake).
  }
}

/**
 * Returns the content of a file at a specific git ref.
 *
 * Common use cases:
 *  - `ref = "HEAD"`              → the fork's current version of the file.
 *  - `ref = "CHERRY_PICK_HEAD"` → the upstream version being cherry-picked.
 *  - `ref = "<sha>"`             → the version at any specific commit.
 *
 * @param cwd      - Absolute path to the repository working directory.
 * @param ref      - Git ref, symbolic name, or SHA.
 * @param filePath - Repository-relative path of the file, e.g. `"src/foo.ts"`.
 * @returns The file content as a UTF-8 string, or `null` if the file does not
 *          exist at the given ref (e.g. the file was added by the cherry-picked commit).
 */
export function getFileAtRef(cwd: string, ref: string, filePath: string, maxBytes?: number): string | null {
  try {
    // `git show <ref>:<path>` streams the blob content to stdout.
    const content = git(["show", `${ref}:${filePath}`], cwd)
    if (maxBytes && content.length > maxBytes) {
      return content.slice(0, maxBytes) + "\n... [truncated]"
    }
    return content
  } catch {
    // Non-zero exit means the path does not exist at that ref.
    return null
  }
}

/**
 * Reads the current working-tree version of a file, including any conflict markers.
 *
 * After a failed cherry-pick, git leaves conflict markers (`<<<<<<<`, `=======`,
 * `>>>>>>>`) in the file.  This function reads that raw content so the agent can
 * analyse it before attempting a resolution.
 *
 * @param cwd      - Absolute path to the repository working directory.
 * @param filePath - Repository-relative path of the file, e.g. `"src/foo.ts"`.
 * @returns The raw file content as a UTF-8 string (may contain conflict markers).
 * @throws If the file does not exist on disk.
 */
export function readWorkingFile(cwd: string, filePath: string): string {
  // Absolute path is constructed by joining cwd and the repo-relative path.
  return readFileSync(`${cwd}/${filePath}`, "utf-8")
}

/**
 * Writes resolved content to a file on disk and stages it with `git add`.
 *
 * Called by the agent after resolving each conflicted file.  The file must
 * contain no conflict markers before calling this function.
 *
 * @param cwd      - Absolute path to the repository working directory.
 * @param filePath - Repository-relative path of the file, e.g. `"src/foo.ts"`.
 * @param content  - Fully resolved file content, free of conflict markers.
 */
export function writeAndStageFile(cwd: string, filePath: string, content: string): void {
  // Write the resolved content to disk, replacing the conflict-marker version.
  writeFileSync(`${cwd}/${filePath}`, content, "utf-8")
  // Stage the file so it is included in the cherry-pick commit.
  git(["add", filePath], cwd)
}

/**
 * Completes an in-progress cherry-pick after all conflicts have been resolved and staged.
 *
 * Uses `GIT_EDITOR=true` to suppress the interactive editor that git would
 * otherwise open for the commit message, making this safe to call in a
 * non-interactive CI environment.
 *
 * @param cwd - Absolute path to the repository working directory.
 * @throws If there are still unstaged conflicted files when this is called.
 */
export function continueCherryPick(cwd: string): void {
  // GIT_EDITOR=true accepts the default commit message without opening an editor.
  // --no-edit is also passed as a belt-and-suspenders precaution.
  execFileSync("git", ["cherry-pick", "--continue", "--no-edit"], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_EDITOR: "true" },
  })
}

/**
 * Pushes the sync branch to the fork remote.
 *
 * A simple non-force push.  If the branch already exists on the remote with
 * different history the push will fail — the agent should never force-push to
 * avoid overwriting human commits.
 *
 * @param cwd        - Absolute path to the repository working directory.
 * @param remote     - Name of the git remote to push to, e.g. `"origin"`.
 * @param branchName - Name of the local branch to push.
 */
export function pushBranch(cwd: string, remote: string, branchName: string): void {
  git(["push", remote, branchName], cwd)
}

/**
 * Fetches both the upstream and fork remotes to bring local refs up to date.
 *
 * Uses a shallow fetch (`--depth=N`) to keep network usage proportional.  The
 * depth here corresponds to `sync.initialFetchDepth`; `ensureMergeBase` will
 * deepen further if needed.
 *
 * @param cwd             - Absolute path to the repository working directory.
 * @param upstreamRemote  - Name of the upstream git remote, e.g. `"upstream"`.
 * @param forkRemote      - Name of the fork git remote, e.g. `"origin"`.
 * @param depth           - Shallow fetch depth.
 */
export function fetchRemotes(cwd: string, upstreamRemote: string, forkRemote: string, depth: number): void {
  git(["fetch", `--depth=${depth}`, upstreamRemote], cwd)
  git(["fetch", `--depth=${depth}`, forkRemote], cwd)
}


```

### `src/git/git-init.ts`

**Exports:** applyGitAuth, ensureWorkingDir

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file git/git-init.ts
 *
 * Repository initialisation and authentication helpers.
 *
 * Two exported functions:
 *
 *  - `applyGitAuth(config)`    — configures the process environment so that all
 *    subsequent git calls (via `git-client.ts`) use the right credentials.
 *    Supports SSH private keys (via `GIT_SSH_COMMAND`) and HTTP bearer tokens
 *    (via git's `http.extraHeader` environment config).
 *
 *  - `ensureWorkingDir(config)` — makes the `workingDir` ready for the agent:
 *    · If the directory does not exist (or is not a git repo): clones `fork.url`.
 *    · If it already exists: fetches all remotes to bring it up to date.
 *    · Ensures the upstream remote is properly configured when its URL is provided
 *      and it differs from the fork remote.
 *
 * Design notes:
 *  - All git I/O is synchronous (matches the rest of git-client.ts).
 *  - No secrets are stored in child-process arguments — tokens are injected via
 *    environment variables only.
 *  - `fork.url` supports any git hosting provider (GitHub, GitLab, Gitea, …).
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { execFileSync } from "node:child_process"
import { git } from "./git-client.js"
import type { SyncConfig } from "../config/schema.js"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a config value that may reference an environment variable.
 *
 * If `value` starts with `$` the remainder is treated as an environment variable
 * name.  This lets operators write `"$GITHUB_TOKEN"` in config.json instead of
 * embedding the raw secret, keeping credentials out of version control.
 *
 * @param value - Raw config string, e.g. `"ghp_abc123"` or `"$MY_TOKEN"`.
 * @returns The resolved string, or `undefined` if the env var is not set.
 */
function resolveConfigValue(value: string): string | undefined {
  if (value.startsWith("$")) {
    return process.env[value.slice(1)]
  }
  return value
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Configures process-level environment variables so that all subsequent git
 * operations (in this process and its child processes) use the right credentials.
 *
 * Priority order:
 *  1. SSH key  (`config.auth.sshKeyPath`)     → sets `GIT_SSH_COMMAND`
 *  2. Token    (`config.auth.githubToken`)    → sets `GIT_CONFIG_*` http.extraHeader
 *  3. Fallback to `GITHUB_TOKEN` env var      → same as (2)
 *
 * If none of the above are set the function is a no-op; git will use whatever
 * credentials are already available in the environment (SSH agent, credential helper…).
 *
 * **Security note:** `GIT_SSH_COMMAND` is executed by git via a shell, so the
 * key path is wrapped in single quotes with internal single quotes escaped
 * (`'\''` sequence) to prevent shell injection if the path contains special
 * characters.
 *
 * @param config - Validated `SyncConfig` loaded from `config.json`.
 */
export function applyGitAuth(config: SyncConfig): void {
  const { sshKeyPath, githubToken } = config.auth

  // --- SSH key ---
  if (sshKeyPath) {
    // Expand leading ~ to the user's home directory.
    const keyPath = sshKeyPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "")
    // Wrap in single quotes and escape embedded single quotes to prevent shell
    // injection: replace each ' with '\'' (close quote, escaped quote, reopen).
    const escapedKeyPath = keyPath.replace(/'/g, "'\\''")
    process.env.GIT_SSH_COMMAND = `ssh -i '${escapedKeyPath}' -o StrictHostKeyChecking=no -o BatchMode=yes`
    process.stderr.write(`[GitAuth] SSH key configured: ${keyPath}\n`)
    return
  }

  // --- HTTP bearer token ---
  const rawToken = githubToken ?? "$GITHUB_TOKEN"
  const token = resolveConfigValue(rawToken)
  if (token) {
    // git supports injecting config via numbered GIT_CONFIG_KEY_N / GIT_CONFIG_VALUE_N env vars.
    // This avoids writing to any config file and works without root access.
    const count = parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10)
    process.env.GIT_CONFIG_COUNT = String(count + 1)
    process.env[`GIT_CONFIG_KEY_${count}`] = "http.extraHeader"
    process.env[`GIT_CONFIG_VALUE_${count}`] = `Authorization: Bearer ${token}`
    process.stderr.write("[GitAuth] HTTP bearer token auth configured.\n")
  }
}

/**
 * Ensures that `config.workingDir` contains a ready-to-use git repository.
 *
 * **Clone** (directory absent or not a git repo):
 *  Clones `config.fork.url` into `config.workingDir`.  The parent directory is
 *  created if necessary.  Throws if `fork.url` is not set.
 *
 * **Sync** (directory is already a git repo):
 *  Runs `git fetch --all --prune` to bring all tracked remotes up to date.
 *
 * **Upstream remote**:
 *  When `config.upstream.url` is set and `upstream.remote` differs from
 *  `fork.remote`, the upstream remote is added (or its URL updated) automatically.
 *
 * @param config - Validated `SyncConfig` loaded from `config.json`.
 * @returns `true` if a network fetch was performed (existing repo case), `false`
 *          if the repo was freshly cloned (no separate fetch needed).
 * @throws If cloning is required but `fork.url` is not configured.
 */
export function ensureWorkingDir(config: SyncConfig): boolean {
  const { workingDir, upstream, fork } = config
  const isGitRepo = existsSync(`${workingDir}/.git`)
  let fetched = false

  // --- Clone if the working directory does not yet exist ---
  if (!isGitRepo) {
    if (!fork.url) {
      throw new Error(
        `[GitInit] '${workingDir}' is not a git repository and fork.url is not configured. ` +
          `Set fork.url to a valid git URL (SSH or HTTPS) to enable automatic cloning.`,
      )
    }
    // Ensure the parent directory exists (git clone does not create it).
    mkdirSync(dirname(workingDir), { recursive: true })
    process.stderr.write(`[GitInit] Cloning ${fork.url} → ${workingDir} ...\n`)
    execFileSync("git", ["clone", fork.url, workingDir], {
      // Pipe stdin, inherit stdout/stderr so clone progress is visible.
      stdio: ["pipe", "inherit", "inherit"],
    })
    process.stderr.write("[GitInit] Clone complete.\n")
    // A fresh clone already has up-to-date refs; no separate fetch needed.
    fetched = false
  } else {
    // --- Fetch all remotes to sync the existing checkout ---
    process.stderr.write(`[GitInit] ${workingDir} found — fetching all remotes...\n`)
    try {
      git(["fetch", "--all", "--prune"], workingDir)
      process.stderr.write("[GitInit] Fetch complete.\n")
      fetched = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Auth failures, missing repos, and permission errors are not recoverable.
      // Running with stale refs after such errors would silently misclassify commits
      // (e.g. mark upstream commits as "already applied" when they haven't been fetched).
      const isFatal = /permission denied|authentication failed|repository not found|could not read username|invalid username|remote: invalid|remote: error|not authorized|bad credentials|403|401/i.test(msg)
      if (isFatal) {
        throw new Error(
          `[GitInit] Fatal fetch error — aborting run to prevent processing stale refs: ${msg}`,
        )
      }
      // Transient network errors: log a highly-visible warning and continue.
      // The agent will detect already-applied commits from local history, but new
      // upstream commits may be missed if the fetch was needed to discover them.
      process.stderr.write(`[GitInit] Warning: fetch failed (may be transient): ${msg}\n`)
      process.stderr.write(
        `[GitInit] WARNING: Running with potentially stale remote refs — candidate commit detection may be inaccurate.\n`,
      )
      fetched = false
    }
  }

  // --- Ensure upstream remote is configured ---
  // Only act when an upstream URL is provided and the upstream remote has a
  // different name than the fork remote (avoids overwriting the fork "origin").
  if (upstream.url && upstream.remote !== fork.remote) {
    try {
      const remotes = git(["remote"], workingDir).split("\n").filter(Boolean)
      if (!remotes.includes(upstream.remote)) {
        git(["remote", "add", upstream.remote, upstream.url], workingDir)
        process.stderr.write(`[GitInit] Added remote '${upstream.remote}' → ${upstream.url}\n`)
      } else {
        const currentUrl = git(["remote", "get-url", upstream.remote], workingDir)
        if (currentUrl !== upstream.url) {
          git(["remote", "set-url", upstream.remote, upstream.url], workingDir)
          process.stderr.write(`[GitInit] Updated remote '${upstream.remote}' → ${upstream.url}\n`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[GitInit] Warning: could not configure upstream remote: ${msg}\n`)
    }
  }

  return fetched
}
```

### `src/git/git-tools.ts`

**Exports:** CHECKPOINT_FILENAME, makeGitTools

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file git/git-tools.ts
 *
 * Factory that creates the agent tools wrapping all low-level git operations.
 *
 * Each tool returned by `makeGitTools` corresponds to a single capability that
 * the LLM can invoke during the sync workflow:
 *
 *  1. `fetch_remotes`          — update local refs from upstream and fork.
 *  2. `list_candidate_commits` — discover which upstream commits to sync.
 *  3. `get_commit_details`     — inspect changed files and full diff.
 *  4. `create_sync_branch`     — branch off the fork tip for this sync run.
 *  5. `cherry_pick_commit`     — apply a single commit; reports conflicts.
 *  6. `abort_cherry_pick`      — abandon a conflicting cherry-pick.
 *  7. `get_conflict_context`   — fetch fork, upstream, and marker-annotated versions.
 *  8. `apply_resolved_file`    — write the LLM's resolution and stage it.
 *  9. `continue_cherry_pick`   — complete the cherry-pick after all files resolved.
 * 10. `push_sync_branch`       — publish the sync branch to the fork remote.
 *
 * All tools respect the `sync.dryRun` flag by returning early with a `dryRun:true`
 * marker instead of performing any mutating operation.
 */

import { z } from "zod"
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs"
import { join as joinPath } from "node:path"
import { minimatch } from "minimatch"
import { defineTool } from "../tool-helper.js"
import {
    ensureMergeBase,
    listCandidateCommits,
    getCommitChangedFiles,
    getCommitDiff,
    createSyncBranch,
    cherryPick,
    abortCherryPick,
    getFileAtRef,
    writeAndStageFile,
    continueCherryPick,
    pushBranch,
    fetchRemotes,
} from "./git-client.js"
import type { SyncConfig } from "../config/schema.js"

/**
 * Tests whether a repo-relative file path matches any of the given patterns.
 *
 * Patterns are either:
 * - A glob string (matched via `minimatch` with `matchBase: true`).
 * - A regex literal in the form `/source/flags` (e.g. `"/^sdk\\/.*\.ts$/i"`).
 *
 * @param filePath - Repo-relative path of the file to test.
 * @param patterns - Array of glob or regex patterns from the config.
 * @returns `true` if the path matches at least one pattern.
 */
function matchesResolvePattern(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Regex literal: /source/flags
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
      const lastSlash = pattern.lastIndexOf("/")
      const source = pattern.slice(1, lastSlash)
      const flags = pattern.slice(lastSlash + 1)
      try {
        if (new RegExp(source, flags).test(filePath)) return true
      } catch {
        // Silently skip malformed regex patterns.
      }
    } else {
      // Glob pattern via minimatch.
      if (minimatch(filePath, pattern, { matchBase: true, nocase: true })) return true
    }
  }
  return false
}

/**
 * Builds and returns all git-related agent tools pre-bound to the provided config.
 *
 * The returned array is spread directly into the `Agent` constructor's `tools`
 * array.  Each tool captures `workingDir`, `upstream`, `fork`, and `sync` from
 * the config via closure, so callers never need to pass them per-invocation.
 *
 * @param config - Validated `SyncConfig` loaded from `config.json`.
 * @returns Array of ten agent tools covering the full git workflow.
 */
export const CHECKPOINT_FILENAME = ".backport-checkpoint.json"

/**
 * Extracts conflict-marker regions from a file with `<<<<<<<` markers, keeping
 * `contextLines` lines of surrounding context on each side of every block.
 * Adjacent or overlapping windows are merged.  Non-adjacent omitted sections are
 * replaced with a `[... N lines omitted ...]` separator so the model knows content
 * was dropped.  Returns the original string unchanged when no markers are found or
 * the result would exceed `maxChars`.
 */
function extractConflictRegions(content: string, maxChars: number, contextLines = 50): string {
  const lines = content.split("\n")
  if (content.length <= maxChars) return content

  // Identify line ranges that contain conflict markers.
  const conflictLineIndices: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith("<<<<<<<") || trimmed.startsWith("=======") || trimmed.startsWith(">>>>>>>")) {
      conflictLineIndices.push(i)
    }
  }

  if (conflictLineIndices.length === 0) {
    // No markers — return head-truncated with a note.
    const truncated = content.slice(0, maxChars)
    return truncated + `\n[... file truncated: ${content.length - maxChars} chars omitted (no conflict markers found) ...]`
  }

  // Build merged windows: [start, end] inclusive line index pairs.
  const windows: Array<[number, number]> = []
  for (const idx of conflictLineIndices) {
    const start = Math.max(0, idx - contextLines)
    const end = Math.min(lines.length - 1, idx + contextLines)
    if (windows.length > 0 && start <= windows[windows.length - 1][1] + 1) {
      // Merge with previous window.
      windows[windows.length - 1][1] = Math.max(windows[windows.length - 1][1], end)
    } else {
      windows.push([start, end])
    }
  }

  // Assemble result from windows, inserting omission notes between them.
  const parts: string[] = []
  let prevEnd = -1
  for (const [start, end] of windows) {
    if (prevEnd === -1 && start > 0) {
      parts.push(`[... ${start} lines omitted ...]`)
    } else if (prevEnd >= 0 && start > prevEnd + 1) {
      parts.push(`[... ${start - prevEnd - 1} lines omitted ...]`)
    }
    parts.push(lines.slice(start, end + 1).join("\n"))
    prevEnd = end
  }
  if (prevEnd < lines.length - 1) {
    parts.push(`[... ${lines.length - 1 - prevEnd} lines omitted ...]`)
  }

  return parts.join("\n")
}

/**
 * Truncates a clean file version (no conflict markers) to `maxChars` characters,
 * appending a note about how many characters were omitted.
 */
function truncateCleanVersion(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + `\n[... ${content.length - maxChars} chars omitted — file too large for context window ...]`
}

export function makeGitTools(config: SyncConfig) {
  // Destructure frequently-used config sections for brevity inside each tool.
  const { workingDir, upstream, fork, sync } = config

  // --- Within-run checkpoint state ---
  // Tracks the current sync branch and successfully applied SHAs so that the
  // agent can resume from the last successful cherry-pick after a crash or retry.
  let checkpointSyncBranch: string | null = null
  let checkpointAppliedShas: string[] = []
  let currentPickSha: string | null = null

  function writeCheckpoint(): void {
    if (sync.dryRun) return
    try {
      writeFileSync(
        joinPath(workingDir, CHECKPOINT_FILENAME),
        JSON.stringify({
          syncBranch: checkpointSyncBranch,
          appliedShas: checkpointAppliedShas,
          timestamp: new Date().toISOString(),
        }, null, 2),
        "utf8",
      )
    } catch (err) {
      process.stderr.write(`[Checkpoint] Warning: could not write checkpoint: ${err}\n`)
    }
  }

  /**
   * Tool: fetch_remotes
   *
   * Fetches the upstream and fork remotes at `sync.initialFetchDepth`, then
   * calls `ensureMergeBase` to deepen the clone if needed.  This must be called
   * once at the start of every run before any other git tool.
   */
  const fetchRemotesTool = defineTool({
    name: "fetch_remotes",
    description: "Fetch both upstream and fork remotes to ensure local refs are up to date.",
    inputSchema: z.object({}),
    execute: async () => {
      // Fetch both remotes at the configured initial depth.
      fetchRemotes(workingDir, upstream.remote, fork.remote, sync.initialFetchDepth)
      // Deepen the clone as needed so that merge-base computation succeeds.
      ensureMergeBase(
        workingDir,
        `${upstream.remote}/${upstream.branch}`,
        `${fork.remote}/${fork.branch}`,
        sync.maxFetchDepth,
      )
      return { success: true }
    },
  })

  /**
   * Tool: list_candidate_commits
   *
   * Uses `git cherry` to compare upstream and fork by patch content.  Commits
   * that have already been applied (even with a different SHA) are excluded.
   * The result is limited to `sync.maxCommitsPerRun` to prevent the agent from
   * processing an unbounded queue in a single session.
   */
  const listCandidatesTool = defineTool({
    name: "list_candidate_commits",
    description:
      "List upstream commits that are not yet applied to the fork branch. " +
      "Uses git cherry to detect already-applied patches by content, not just SHA. " +
      "Returns an array of candidate commits with their SHA, subject, and alreadyApplied flag.",
    inputSchema: z.object({}),
    execute: async () => {
      const candidates = listCandidateCommits(
        workingDir,
        `${upstream.remote}/${upstream.branch}`,
        `${fork.remote}/${fork.branch}`,
        sync.prNumberMatching.enabled ? sync.prNumberMatching : undefined,
      )

      // Compile skipCommits patterns once.  Each string is treated as a
      // case-insensitive regular expression matched against the commit subject.
      const skipPatterns = (sync.skipCommits ?? []).map((p) => {
        try {
          return new RegExp(p, "i")
        } catch {
          process.stderr.write(`[list_candidate_commits] Warning: invalid skipCommits pattern "${p}" — ignored\n`)
          return null
        }
      }).filter(Boolean) as RegExp[]

      // Filter out already-applied and explicitly skipped commits, then cap to the
      // configured run limit.
      const pending = candidates.filter((c) => {
        if (c.alreadyApplied) return false
        const skipped = skipPatterns.some((re) => re.test(c.subject))
        if (skipped) {
          process.stderr.write(
            `[list_candidate_commits] Skipping ${c.sha.slice(0, 8)} (matches skipCommits): ${c.subject}\n`,
          )
        }
        return !skipped
      }).slice(0, sync.maxCommitsPerRun)

      return { candidates: pending, total: pending.length }
    },
  })

  /**
   * Tool: get_commit_details
   *
   * Returns the changed file list for a given commit SHA.
   * The diff is intentionally NOT exposed here — AI tools (analyze_commit_for_backport,
   * check_customization_compatibility) fetch it internally as needed to avoid adding
   * it to the main orchestrator context.
   */
  const getCommitDetailsTool = defineTool({
    name: "get_commit_details",
    description:
      "Get the list of changed files for a specific upstream commit. " +
      "Use this before classifying risk. " +
      "NOTE: The diff is NOT included here — AI analysis tools fetch it internally.",
    inputSchema: z.object({
      sha: z.string().describe("The commit SHA to inspect"),
    }),
    execute: async ({ sha }) => {
      const changedFiles = getCommitChangedFiles(workingDir, sha)
      return { sha, changedFiles }
    },
  })

  /**
   * Tool: create_sync_branch
   *
   * Creates a new local branch named `<branchPrefix><upstreamBranch>-<date>`
   * branching off `<forkRemote>/<forkBranch>`.  No-ops in dry-run mode.
   * The branch name is returned so subsequent tools can reference it.
   */
  const createSyncBranchTool = defineTool({
    name: "create_sync_branch",
    description:
      "Create a new sync branch from the fork branch tip. " +
      "The branch name is auto-generated with today's date. Returns the branch name.",
    inputSchema: z.object({}),
    execute: async () => {
      // Skip actual branch creation in dry-run mode.
      if (sync.dryRun) return { branchName: null, dryRun: true }
      // Build the branch name from the configured prefix, upstream branch, today's date,
      // and the current UTC time (HHMM) to avoid collisions when the agent runs
      // more than once in the same calendar day.
      const now = new Date()
      const date = now.toISOString().slice(0, 10)             // "YYYY-MM-DD"
      const time = now.toISOString().slice(11, 19).replace(/:/g, "")  // "HHMMSS"
      const branchName = `${sync.branchPrefix}${upstream.branch}-${date}-${time}`
      createSyncBranch(workingDir, branchName, `${fork.remote}/${fork.branch}`)
      checkpointSyncBranch = branchName
      writeCheckpoint()
      return { branchName }
    },
  })

  /**
   * Tool: cherry_pick_commit
   *
   * Attempts to cherry-pick the given SHA.  On success, the commit is already
   * committed to the local branch.  On conflict, git leaves the cherry-pick in
   * progress; the agent should call `get_conflict_context` / `apply_resolved_file`
   * / `continue_cherry_pick` in sequence, or `abort_cherry_pick` to give up.
   */
  const cherryPickCommitTool = defineTool({
    name: "cherry_pick_commit",
    description:
      "Attempt to cherry-pick a single upstream commit onto the current sync branch. " +
      "Returns success:true if clean, or success:false with conflictedFiles if conflicts arose. " +
      "On conflict, the cherry-pick is left in progress for the resolve_conflict tool.",
    inputSchema: z.object({
      sha: z.string().describe("Upstream commit SHA to cherry-pick"),
    }),
    execute: async ({ sha }) => {
      // Dry-run: report success without touching the repository.
      if (sync.dryRun) return { success: true, dryRun: true, conflictedFiles: [] }
      currentPickSha = sha
      const result = cherryPick(workingDir, sha)
      if (result.success) {
        checkpointAppliedShas.push(sha)
        currentPickSha = null
        writeCheckpoint()
      }
      return result
    },
  })

  /**
   * Tool: abort_cherry_pick
   *
   * Calls `git cherry-pick --abort` to discard any partially applied changes and
   * restore the working tree to the state before the cherry-pick started.  Should
   * be called when the agent decides a conflict is too complex to resolve safely.
   */
  const abortCherryPickTool = defineTool({
    name: "abort_cherry_pick",
    description: "Abort the current cherry-pick in progress. Call this when a conflict cannot be resolved automatically.",
    inputSchema: z.object({}),
    execute: async () => {
      abortCherryPick(workingDir)
      return { aborted: true }
    },
  })

  /**
   * Tool: get_conflict_context
   *
   * Returns three views of a conflicted file so the LLM has all the information
   * it needs for a principled resolution:
   *  - `forkVersion`     — the file as it existed in HEAD before the cherry-pick.
   *  - `upstreamVersion` — the file as it exists in CHERRY_PICK_HEAD (incoming).
   *  - `withMarkers`     — the current working-tree content with `<<<<<<<` markers.
   *
   * `forkVersion` or `upstreamVersion` may be `null` if the file is new on one side.
   */
  const getConflictContextTool = defineTool({
    name: "get_conflict_context",
    description:
      "For a conflicted file, return the fork version (HEAD), the upstream version (CHERRY_PICK_HEAD), " +
      "and the current file content with conflict markers. Use this to gather context before resolving.",
    inputSchema: z.object({
      filePath: z.string().describe("Repo-relative path of the conflicted file"),
    }),
    execute: async ({ filePath }) => {
      // Fetch the fork's current committed version (may be null for new files).
      const rawForkVersion = getFileAtRef(workingDir, "HEAD", filePath)
      // Fetch the incoming upstream version (may be null for deleted files).
      const rawUpstreamVersion = getFileAtRef(workingDir, "CHERRY_PICK_HEAD", filePath)
      // Read the working-tree file which contains conflict markers.
      let rawWithMarkers: string | null = null
      try {
        rawWithMarkers = readFileSync(`${workingDir}/${filePath}`, "utf-8")
      } catch {
        // The file may have been deleted by the upstream commit.
        rawWithMarkers = null
      }

      // Deterministic strategy override from config.resolve.
      // `theirs` is checked first; if a file matches both, theirs wins.
      let forcedStrategy: "ours" | "theirs" | null = null
      const resolveConfig = config.resolve
      if (resolveConfig) {
        if (matchesResolvePattern(filePath, resolveConfig.theirs ?? [])) {
          forcedStrategy = "theirs"
        } else if (matchesResolvePattern(filePath, resolveConfig.ours ?? [])) {
          forcedStrategy = "ours"
        }
      }

      // Apply per-version character limits to prevent context-window overflow for
      // large auto-generated files (e.g. model catalogs, lock files).
      // withMarkers is truncated by extracting only the conflict-marker regions
      // (with surrounding context lines); forkVersion / upstreamVersion are
      // head-truncated since they have no markers to guide extraction.
      const maxChars = sync.maxConflictContextChars
      const forkVersion = rawForkVersion !== null ? truncateCleanVersion(rawForkVersion, maxChars) : null
      const upstreamVersion = rawUpstreamVersion !== null ? truncateCleanVersion(rawUpstreamVersion, maxChars) : null
      const withMarkers = rawWithMarkers !== null ? extractConflictRegions(rawWithMarkers, maxChars) : null

      const truncated =
        (rawForkVersion !== null && forkVersion !== rawForkVersion) ||
        (rawUpstreamVersion !== null && upstreamVersion !== rawUpstreamVersion) ||
        (rawWithMarkers !== null && withMarkers !== rawWithMarkers)

      if (truncated) {
        process.stderr.write(
          `[Context] get_conflict_context: truncated large file "${filePath}" to ${maxChars} chars/version\n`,
        )
      }

      return { filePath, forkVersion, upstreamVersion, withMarkers, forcedStrategy, truncated }
    },
  })

  /**
   * Tool: apply_resolved_file
   *
   * Writes the LLM-provided resolution for a single conflicted file to disk and
   * runs `git add` to stage it.  Must be called for every conflicted file before
   * `continue_cherry_pick`.  The `resolvedContent` must be free of conflict markers.
   */
  const applyResolvedFileTool = defineTool({
    name: "apply_resolved_file",
    description:
      "Write the resolved content for a conflicted file and stage it. " +
      "Call this for each conflicted file before calling continue_cherry_pick.",
    inputSchema: z.object({
      filePath: z.string().describe("Repo-relative path of the file"),
      resolvedContent: z.string().describe("The fully resolved file content, with no conflict markers"),
    }),
    execute: async ({ filePath, resolvedContent }) => {
      // Skip file write in dry-run mode.
      if (sync.dryRun) return { staged: false, dryRun: true }
      writeAndStageFile(workingDir, filePath, resolvedContent)
      return { staged: true, filePath }
    },
  })

  /**
   * Tool: continue_cherry_pick
   *
   * Finalises the cherry-pick after all conflicted files have been resolved and
   * staged.  Internally calls `git cherry-pick --continue --no-edit` with
   * `GIT_EDITOR=true` so that no interactive editor is opened.
   */
  const continueCherryPickTool = defineTool({
    name: "continue_cherry_pick",
    description:
      "Complete the cherry-pick after all conflicted files have been resolved and staged via apply_resolved_file.",
    inputSchema: z.object({}),
    execute: async () => {
      // Skip in dry-run mode.
      if (sync.dryRun) return { committed: false, dryRun: true }
      continueCherryPick(workingDir)
      if (currentPickSha) {
        checkpointAppliedShas.push(currentPickSha)
        currentPickSha = null
        writeCheckpoint()
      }
      return { committed: true }
    },
  })

  /**
   * Tool: push_sync_branch
   *
   * Pushes the named sync branch to `fork.remote`.  Called once after all commits
   * have been processed.  Only a non-force push is performed to avoid overwriting
   * human commits on the remote.
   */
  const pushSyncBranchTool = defineTool({
    name: "push_sync_branch",
    description: "Push the current sync branch to the fork remote.",
    inputSchema: z.object({
      /** Name of the local sync branch to push, as returned by `create_sync_branch`. */
      branchName: z.string(),
    }),
    execute: async ({ branchName }) => {
      // Skip push in dry-run mode.
      if (sync.dryRun) return { pushed: false, dryRun: true }
      pushBranch(workingDir, fork.remote, branchName)
      return { pushed: true, branchName }
    },
  })

  return [
    fetchRemotesTool,
    listCandidatesTool,
    getCommitDetailsTool,
    createSyncBranchTool,
    cherryPickCommitTool,
    abortCherryPickTool,
    getConflictContextTool,
    applyResolvedFileTool,
    continueCherryPickTool,
    pushSyncBranchTool,
  ]
}
```

### `src/github/github-tools.ts`

**Exports:** makeGitHubTools

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file github/github-tools.ts
 *
 * GitHub API tools that allow the agent to manage pull requests on the fork
 * repository.  All operations go through the official `@octokit/rest` client
 * which enforces HTTPS and authenticated requests.
 *
 * The three tools returned by `makeGitHubTools` cover the PR lifecycle:
 *  1. `find_existing_sync_pr` — check whether a previous run already opened a PR,
 *     and if so, recover its machine-readable state so the current run can resume.
 *  2. `create_sync_pr`        — open a new draft PR with the sync branch, embedding
 *     both human-readable Markdown and a hidden machine-readable state block.
 *  3. `add_human_review_comment` — flag specific files or decisions for a human
 *     reviewer by posting a comment on the PR.
 *
 * **Idempotency** is achieved via `STATE_MARKER_START/END` HTML comment markers
 * embedded inside the PR body.  On each run the agent first calls
 * `find_existing_sync_pr`, which extracts and parses the JSON state block if
 * present, allowing the run to skip already-processed commits.
 *
 * **Authentication** is read from the `GITHUB_TOKEN` environment variable at
 * tool invocation time (not at module load time) so that the token is never
 * stored in process memory longer than necessary.
 */

import { z } from "zod"
import { defineTool } from "../tool-helper.js"
import { Octokit } from "@octokit/rest"
import type { SyncConfig } from "../config/schema.js"

/**
 * Creates and returns an authenticated Octokit instance using the `GITHUB_TOKEN`
 * environment variable.
 *
 * Called inside each tool's `execute` function rather than once at module level
 * to keep the token out of long-lived closures.
 *
 * @returns Authenticated `Octokit` REST client.
 * @throws If `GITHUB_TOKEN` is not set in the environment.
 */
function makeOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error("GITHUB_TOKEN environment variable is required")
  return new Octokit({ auth: token })
}

/**
 * Parses an `"owner/repo"` string into its component parts.
 *
 * @param repoStr - Repository string in `"owner/repo"` format.
 * @returns An object with `owner` and `repo` string fields.
 * @throws If the string does not contain exactly one `/` separator.
 */
function parseRepo(repoStr: string): { owner: string; repo: string } {
  const [owner, repo] = repoStr.split("/")
  if (!owner || !repo) throw new Error(`Invalid repo format: "${repoStr}", expected "owner/repo"`)
  return { owner, repo }
}

/**
 * Opening delimiter of the hidden JSON state block embedded in the PR body.
 *
 * The state block is wrapped in an HTML comment so it is invisible in the
 * rendered PR view but can be extracted programmatically on re-runs.
 * Example embedded block:
 * ```
 * <!-- backport-agent-state
 * { "processedShas": ["abc123", "def456"] }
 * -->
 * ```
 */
const STATE_MARKER_START = "<!-- backport-agent-state\n"

/**
 * Closing delimiter of the hidden JSON state block embedded in the PR body.
 * @see STATE_MARKER_START
 */
const STATE_MARKER_END = "\n-->"

/**
 * Builds and returns the three GitHub API agent tools.
 *
 * All tools capture `fork`, `upstream`, and `sync` from the config via closure.
 * In dry-run mode, every tool returns early with `{ dryRun: true }` and performs
 * no network requests.
 *
 * @param config - Validated `SyncConfig` loaded from `config.json`.
 * @returns Array of three agent tools: `[findExistingPrTool, createSyncPrTool, addHumanReviewCommentTool]`.
 */
export function makeGitHubTools(config: SyncConfig) {
  // Destructure the config sections needed by the tools.
  const { fork, upstream, sync } = config

  /**
   * Tool: find_existing_sync_pr
   *
   * Queries the fork repository for open PRs whose title starts with
   * `"Sync upstream"` and whose body contains the `STATE_MARKER_START` sentinel.
   *
   * If a matching PR is found, the hidden state JSON is extracted and returned
   * so the calling agent can resume from where a previous run left off.
   */
  const findExistingPrTool = defineTool({
    name: "find_existing_sync_pr",
    description:
      "Search for an existing open sync PR created by the backport agent. " +
      "Returns the PR number and current state JSON if found, null otherwise.",
    inputSchema: z.object({}),
    execute: async () => {
      // Skip network call in dry-run mode.
      if (sync.dryRun) return { pr: null, dryRun: true }

      const octokit = makeOctokit()
      const { owner, repo } = parseRepo(fork.repo)

      // List open PRs whose head branch starts with the configured prefix.
      const { data: prs } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        head: `${owner}:${sync.branchPrefix}`,
        per_page: 10,
      })

      // Find the most recent backport-agent PR by checking title and body marker.
      const agentPr = prs.find(
        (pr) => pr.title.startsWith("Sync upstream") && pr.body?.includes(STATE_MARKER_START),
      )
      if (!agentPr) return { pr: null }

      // Extract the embedded JSON state from the PR body.
      let agentState: Record<string, unknown> | null = null
      if (agentPr.body) {
        const start = agentPr.body.indexOf(STATE_MARKER_START)
        const end = agentPr.body.indexOf(STATE_MARKER_END, start)
        if (start !== -1 && end !== -1) {
          try {
            // Slice out just the JSON content between the two markers.
            agentState = JSON.parse(agentPr.body.slice(start + STATE_MARKER_START.length, end))
          } catch {
            // Malformed JSON is treated as missing state — the run starts fresh.
            agentState = null
          }
        }
      }
      return { pr: { number: agentPr.number, url: agentPr.html_url, state: agentState } }
    },
  })

  /**
   * Tool: create_sync_pr
   *
   * Opens a draft pull request from the sync branch into `fork.branch`.  The PR
   * body consists of the agent-generated Markdown summary followed by the hidden
   * state block.  Labels are applied as a best-effort operation (non-fatal if
   * they don't exist on the repository).
   */
  const createSyncPrTool = defineTool({
    name: "create_sync_pr",
    description:
      "Create a draft pull request on the fork repository with the sync branch. " +
      "Embeds a hidden state block for idempotent re-runs. Returns the PR URL.",
    inputSchema: z.object({
      /** Name of the local/remote sync branch created by `create_sync_branch`. */
      branchName: z.string(),
      /** Human-readable Markdown body shown in the GitHub PR UI. */
      markdownBody: z.string().describe("Human-readable PR body in Markdown"),
      /** Machine-readable JSON state to embed as a hidden comment for re-run idempotency. */
      agentState: z.record(z.string(), z.unknown()).describe("Machine-readable state to embed in the PR body"),
      /** Labels to apply to the PR.  Defaults to `["sync", "agent-generated"]`. */
      labels: z.array(z.string()).default(["sync", "agent-generated"]),
    }),
    execute: async ({ branchName, markdownBody, agentState, labels }) => {
      // Skip PR creation in dry-run mode.
      if (sync.dryRun) return { url: null, dryRun: true }

      const octokit = makeOctokit()
      const { owner, repo } = parseRepo(fork.repo)
      const date = new Date().toISOString().slice(0, 10)

      // Build the hidden state block: JSON surrounded by the HTML comment markers.
      const hiddenState = `${STATE_MARKER_START}${JSON.stringify(agentState, null, 2)}${STATE_MARKER_END}`
      // Concatenate the human-readable body with the hidden state block.
      const body = `${markdownBody}\n\n${hiddenState}`

      // Create the draft PR via the GitHub REST API.
      const { data: pr } = await octokit.pulls.create({
        owner,
        repo,
        title: `Sync upstream ${upstream.branch} into ${fork.branch} (${date})`,
        body,
        head: branchName,
        base: fork.branch,
        draft: true,
      })

      // Apply labels — best-effort; labels may not exist on the repository.
      try {
        await octokit.issues.addLabels({ owner, repo, issue_number: pr.number, labels })
      } catch {
        // Non-fatal: labels are cosmetic and their absence does not affect workflow.
      }

      return { url: pr.html_url, number: pr.number }
    },
  })

  /**
   * Tool: add_human_review_comment
   *
   * Posts a Markdown comment on an existing sync PR.  Used when the agent
   * encounters a conflict or edge case it cannot safely resolve automatically
   * and needs to escalate to a human reviewer.
   */
  const addHumanReviewCommentTool = defineTool({
    name: "add_human_review_comment",
    description:
      "Add a comment to the sync PR flagging a specific file or decision for human review. " +
      "Use when the agent cannot safely resolve a conflict automatically.",
    inputSchema: z.object({
      /** PR number on the fork repository to comment on. */
      prNumber: z.number().int(),
      /** Markdown-formatted comment body explaining what needs human attention. */
      comment: z.string().describe("Markdown comment explaining what needs human attention"),
    }),
    execute: async ({ prNumber, comment }) => {
      // Skip comment posting in dry-run mode.
      if (sync.dryRun) return { commented: false, dryRun: true }

      const octokit = makeOctokit()
      const { owner, repo } = parseRepo(fork.repo)
      // Post the comment as a regular issue comment (PRs are issues in GitHub API).
      await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body: comment })
      return { commented: true }
    },
  })

  /**
   * Tool: auto_merge_pr
   *
   * Merges an open PR via the GitHub REST API using the configured merge method.
   * Only callable when `config.sync.autoMergeOnSuccess` is `true`.
   *
   * After a successful merge, optionally deletes the head branch if
   * `config.sync.autoMergeDeleteBranch` is `true`.
   *
   * The agent MUST only call this tool when:
   *  1. All candidate commits were applied or skipped (none are conflict-blocked or
   *     validation-failed).
   *  2. `run_validation` returned `allPassed: true`.
   *  3. The task context line says "Auto-merge on success: enabled".
   */
  const autoMergePrTool = defineTool({
    name: "auto_merge_pr",
    description:
      "Merge the sync PR via the GitHub API after all commits were successfully applied and validation passed. " +
      "Only call this when the task context says 'Auto-merge on success: enabled' and run_validation returned allPassed:true. " +
      "Uses the merge method from config (squash | merge | rebase). " +
      "Optionally deletes the head branch after merge.",
    inputSchema: z.object({
      /** PR number returned by `create_sync_pr`. */
      prNumber: z.number().int().describe("PR number to merge"),
    }),
    execute: async ({ prNumber }) => {
      if (sync.dryRun) return { merged: false, dryRun: true }
      if (!sync.autoMergeOnSuccess) {
        return { merged: false, disabled: true, reason: "autoMergeOnSuccess is not enabled in config" }
      }

      const octokit = makeOctokit()
      const { owner, repo } = parseRepo(fork.repo)

      // Fetch PR head branch name before merging (needed for deletion).
      const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber })
      const headBranch = pr.head.ref

      const { data: mergeResult } = await octokit.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: sync.autoMergeMethod,
      })

      let branchDeleted = false
      if (sync.autoMergeDeleteBranch) {
        try {
          await octokit.git.deleteRef({ owner, repo, ref: `heads/${headBranch}` })
          branchDeleted = true
        } catch {
          // Non-fatal — the branch may already be protected or the token may lack
          // the delete-branch permission.
        }
      }

      return { merged: true, sha: mergeResult.sha, branchDeleted }
    },
  })

  return [findExistingPrTool, createSyncPrTool, addHumanReviewCommentTool, autoMergePrTool]
}
```

### `src/main.ts`

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file main.ts
 *
 * Entry point for the Backport Agent CLI.
 *
 * **Initialization sequence:**
 *  1. Parse CLI arguments (`--verbose`, `--config`, `--backport-customizations`,
 *     `--provider`, `--api-key`, `--keypool-vault-url`, `--keypool-live-secret`,
 *     `--keypool-state-file`, `--dry-run`).
 *  2. Load and validate `config.json` via `loadConfig()` (CLI flags override JSON values).
 *  3. Load and validate `customizations.yaml` via `loadCustomizations()`.
 *  4. Assemble all agent tools from the individual factory functions.
 *  5. Instantiate the `Agent` with the configured provider, system prompt, and tools.
 *  6. Subscribe to runtime events to stream assistant output to stdout.
 *  7. Call `agent.run(task)` with the sync task description.
 *  8. Print the final report (or exit with code 1 on any fatal error).
 *
 * **Provider resolution:**
 * The LLM provider is set by `config.models.provider` in `config.json` and can be
 * overridden at runtime with `--provider`.  The API key is resolved in this order:
 *  1. `--api-key <key>` CLI flag (or `_CLI_API_KEY` env var).
 *  2. `config.models.apiKey` literal value or `"$ENV_VAR"` reference.
 *  3. `{PROVIDER_UPPER}_API_KEY` environment variable (e.g. `ANTHROPIC_API_KEY`).
 *  4. `undefined` — the SDK attempts its own credential discovery.
 *  The special value `"auto"` is accepted by the `keypoollive` provider to trigger
 *  vault-based key rotation via `KEYPOOL_VAULT_URL`.
 */
/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { resolve as resolvePath, join as joinPath } from "node:path"
import { parseCliArgs } from "./cli/args.js"
import { loadConfig } from "./config/loader.js"
import { applyGitAuth, ensureWorkingDir } from "./git/git-init.js"
import { ensureMergeBase, fetchRemotes, listCandidateCommits } from "./git/git-client.js"
import { buildNoopSyncReport } from "./reports/noop-report.js"
import { buildContextAbortReport } from "./reports/context-abort-report.js"
import { setupAgent } from "./agent/agent-setup.js"
import { setupEventHandlers } from "./agent/event-handlers.js"
import { runWithRetry } from "./agent/retry-logic.js"
import { CHECKPOINT_FILENAME } from "./git/git-tools.js"
import type { SyncConfig } from "./config/schema.js"

/**
 * Gets the sync branch name from the checkpoint file if available, otherwise generates
 * a fallback branch name using the same pattern as createSyncBranchTool.
 *
 * @param config - The sync configuration
 * @returns The sync branch name
 */
function getSyncBranchNameFromCheckpoint(config: SyncConfig): string {
  const checkpointPath = joinPath(config.workingDir, CHECKPOINT_FILENAME)
  if (existsSync(checkpointPath)) {
    try {
      const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"))
      if (checkpoint.syncBranch) {
        return checkpoint.syncBranch
      }
    } catch {
      // Silently fall through to default
    }
  }
  // Default fallback - matches the pattern used in createSyncBranchTool
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `${config.sync.branchPrefix}${config.upstream.branch}-${date}-${time}`
}

// ---------------------------------------------------------------------------
// CLI argument parsing — runs before .env loading so flags can override env.
// ---------------------------------------------------------------------------
parseCliArgs()

// Load .env file if present — allows setting KEYPOOL_VAULT_URL, KEYPOOL_LIVE_SECRET,
// BACKPORT_CUSTOMIZATIONS, etc. without modifying the shell environment.
// Uses Node.js 20.6+ built-in --env-file support via the `dotenv` fallback.
{
  const envPath = resolvePath(process.cwd(), ".env")
  if (existsSync(envPath)) {
    const { config } = await import("dotenv")
    config({ path: envPath })
  }
}

// ---------------------------------------------------------------------------
// Key usage reporting functions
// ---------------------------------------------------------------------------

/**
 * Generates a detailed key usage report from keypoolStats.
 * @param keypoolStats - The keypool statistics object
 * @returns Markdown formatted key usage report
 */
function generateKeyUsageReport(keypoolStats: {
  keysUsed: Set<{
    event: string
    owner: string
    keyHint: string
    modelId: string
    usage?: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
    }
  }>
}) {
  // Filter only usage-recorded events
  const usageRecords = Array.from(keypoolStats.keysUsed).filter(
    (usage) => usage.event === "usage-recorded" && usage.usage
  )

  if (usageRecords.length === 0) {
    return ""
  }

  // Calculate tokens by modelId
  const tokensByModelId = new Map<string, { input: number; output: number; total: number }>()
  for (const record of usageRecords) {
    if (record.usage) {
      const current = tokensByModelId.get(record.modelId) || { input: 0, output: 0, total: 0 }
      tokensByModelId.set(record.modelId, {
        input: current.input + record.usage.input,
        output: current.output + record.usage.output,
        total: current.total + record.usage.input + record.usage.output
      })
    }
  }

  // Calculate tokens by key and modelId
  const tokensByKeyAndModelId = new Map<string, Map<string, { input: number; output: number; total: number }>>()
  for (const record of usageRecords) {
    if (record.usage) {
      const keyMap = tokensByKeyAndModelId.get(record.keyHint) || new Map()
      const current = keyMap.get(record.modelId) || { input: 0, output: 0, total: 0 }
      keyMap.set(record.modelId, {
        input: current.input + record.usage.input,
        output: current.output + record.usage.output,
        total: current.total + record.usage.input + record.usage.output
      })
      tokensByKeyAndModelId.set(record.keyHint, keyMap)
    }
  }

  // Generate the report
  const reportLines: string[] = []

  reportLines.push("## Detailed Key Usage Report")
  reportLines.push("")
  reportLines.push("### Tokens by Model ID")
  reportLines.push("")
  reportLines.push("| Model ID | Input Tokens | Output Tokens | Total Tokens |")
  reportLines.push("|---|---|---|---|")

  // Sort by total tokens descending
  const sortedModels = Array.from(tokensByModelId.entries()).sort(
    (a, b) => b[1].total - a[1].total
  )

  for (const [modelId, tokens] of sortedModels) {
    reportLines.push(
      `| \`${modelId}\` | ${tokens.input.toLocaleString()} | ${tokens.output.toLocaleString()} | ${tokens.total.toLocaleString()} |`
    )
  }

  reportLines.push("")
  reportLines.push("### Tokens by Key and Model ID")
  reportLines.push("")
  reportLines.push("| Key Hint | Model ID | Input Tokens | Output Tokens | Total Tokens |")
  reportLines.push("|---|---|---|---|---|")

  // Sort keys by total usage descending
  const sortedKeys = Array.from(tokensByKeyAndModelId.entries()).sort((a, b) => {
    const totalA = Array.from(a[1].values()).reduce((sum, t) => sum + t.total, 0)
    const totalB = Array.from(b[1].values()).reduce((sum, t) => sum + t.total, 0)
    return totalB - totalA
  })

  for (const [keyHint, modelMap] of sortedKeys) {
    // Sort models by usage for this key
    const sortedModelsForKey = Array.from(modelMap.entries()).sort(
      (a, b) => b[1].total - a[1].total
    )

    for (const [modelId, tokens] of sortedModelsForKey) {
      reportLines.push(
        `| \`${keyHint}\` | \`${modelId}\` | ${tokens.input.toLocaleString()} | ${tokens.output.toLocaleString()} | ${tokens.total.toLocaleString()} |`
      )
    }
  }

  return reportLines.join("\n")
}

// ---------------------------------------------------------------------------
// Entry point — async main() is wrapped in .catch() for clean error exit.
// ---------------------------------------------------------------------------

/**
 * Main async entry point.
 *
 * Orchestrates the full agent lifecycle from environment validation through
 * report output.  On any unhandled error the process exits with code 1.
 *
 * @throws On missing environment variables, invalid config, or agent failure.
 */
async function main() {
  // --- Config loading ---
  const config = loadConfig(process.env._CLI_CONFIG_PATH)
  // Clear the CLI API key from process.env immediately after use so it is not
  // inherited by child processes spawned later (e.g. git, npm validation commands).
  delete process.env._CLI_API_KEY

  // --- Authentication + working directory setup ---
  // applyGitAuth sets process-level env vars (GIT_SSH_COMMAND or GIT_CONFIG_*)
  // before any git call is made, so all subsequent operations use the right creds.
  // ensureWorkingDir clones the fork repo if it doesn't exist, or fetches all
  // remotes if it does, bringing the checkout up to date before the agent starts.
  applyGitAuth(config)
  const alreadyFetched = ensureWorkingDir(config)

  const upstreamRef = `${config.upstream.remote}/${config.upstream.branch}`
  const forkRef = `${config.fork.remote}/${config.fork.branch}`

  // ensureWorkingDir already called `git fetch --all --prune` for existing repos;
  // skip the targeted fetchRemotes to avoid a redundant network round-trip.
  if (!alreadyFetched) {
    fetchRemotes(config.workingDir, config.upstream.remote, config.fork.remote, config.sync.initialFetchDepth)
  }
  ensureMergeBase(config.workingDir, upstreamRef, forkRef, config.sync.maxFetchDepth)

  const allCandidates = listCandidateCommits(
    config.workingDir,
    upstreamRef,
    forkRef,
    config.sync.prNumberMatching.enabled ? config.sync.prNumberMatching : undefined,
  )

  // --- --list-backport-needed: print pending commits and exit without running the agent ---
  if (process.env._CLI_LIST_BACKPORT_NEEDED === "true") {
    const pending = allCandidates.filter((c) => !c.alreadyApplied)
    if (pending.length === 0) {
      console.log("No upstream commits pending.")
    } else {
      console.log(`${pending.length} commit(s) pending backport from ${upstreamRef} into ${forkRef} (oldest first):\n`)
      for (const c of pending) {
        console.log(`${c.sha}  ${c.subject}`)
      }
    }
    return
  }

  const pendingCommits = allCandidates
    .filter((candidate) => !candidate.alreadyApplied)
    .slice(0, config.sync.maxCommitsPerRun)

  if (pendingCommits.length === 0) {
    const dryRunNote = config.sync.dryRun ? " [DRY RUN — no changes will be pushed]" : ""
    console.error(`\n=== Backport Agent starting${dryRunNote} ===\n`)
    console.error("No upstream commits pending; skipping agent run.\n")
    console.error("=== Run complete ===\n")
    console.log(buildNoopSyncReport({ upstreamRef, forkRef, dryRun: config.sync.dryRun }))
    return
  }

  // --- Prompt log file for this run ---
  // Every sub-agent LLM call is appended here.
  // Written alongside run reports inside config.report.destination.
  const reportDir = resolvePath(config.workingDir, config.report.destination)
  mkdirSync(reportDir, { recursive: true })
  const promptLogPath = joinPath(reportDir, `run-${Date.now()}.prompts.jsonl`)
  process.stderr.write(`[PromptLogger] Writing sub-agent logs to: ${promptLogPath}\n`)

  // --- Agent setup ---
  const verbose = process.env.VERBOSE === "true"
  const { agentFactory, userInstructionService, keypoolStats } = await setupAgent({
    config,
    promptLogPath,
    verbose
  })

  // --- Event handlers setup ---
  // No agent passed here — subscribeToAgent() is called inside runWithRetry for each attempt.
  const eventHandlers = setupEventHandlers({ verbose })

  // --- Checkpoint resumption ---
  // If a previous run left a checkpoint file (crash mid-run), include the
  // already-applied SHAs in the task so the agent skips them.
  const checkpointPath = joinPath(config.workingDir, CHECKPOINT_FILENAME)
  let checkpointNote = ""
  if (existsSync(checkpointPath)) {
    try {
      const cp = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
        syncBranch?: string | null
        appliedShas?: string[]
        timestamp?: string
      }
      if (cp.appliedShas && cp.appliedShas.length > 0) {
        checkpointNote =
          `\nPrevious run checkpoint found (from ${cp.timestamp ?? "unknown"}):\n` +
          `  Sync branch: ${cp.syncBranch ?? "(not yet created)"}\n` +
          `  Already applied SHAs (skip these — do NOT re-apply):\n` +
          cp.appliedShas.map((s) => `    - ${s}`).join("\n") + "\n"
        process.stderr.write(`[Checkpoint] Resuming from checkpoint: ${cp.appliedShas.length} SHA(s) already applied\n`)
      }
    } catch {
      process.stderr.write(`[Checkpoint] Warning: could not read checkpoint file — starting fresh\n`)
    }
  }

  // --- Task construction ---
  const dryRunNote = config.sync.dryRun ? " [DRY RUN — no changes will be pushed]" : ""
  const autoMergeNote = config.sync.autoMergeOnSuccess
    ? `Auto-merge on success: enabled (method: ${config.sync.autoMergeMethod})\n`
    : ""

  const task =
    `Synchronize the fork \`${config.fork.repo}@${config.fork.branch}\` with upstream ` +
    `\`${config.upstream.repo}@${config.upstream.branch}\`.${dryRunNote}\n\n` +
    `Working directory: ${config.workingDir}\n` +
    `Max commits per run: ${config.sync.maxCommitsPerRun}\n` +
    autoMergeNote +
    checkpointNote

  console.error(`\n=== Backport Agent starting${dryRunNote} ===\n`)

  // --- Run the agent with retry logic ---
  // The agent loop runs until the `generate_report` tool is called
  // (`lifecycle: { completesRun: true }`) or an unrecoverable error occurs.
  let reportMarkdown: string | null = null
  try {
    const result = await runWithRetry({
      agentFactory,
      task,
      eventHandlers,
      getLastInputTokens: () => keypoolStats.lastInputTokens,
    })

    console.error(`\n=== Run complete ===\n`)
    if (result.outputText) {
      // The run may complete via generate_report (JSON output) or submit_and_exit (plain text).
      // Try to extract the Markdown report from JSON; fall back to plain text.
      try {
        const parsedReport = JSON.parse(result.outputText) as { report?: string }
        reportMarkdown = parsedReport.report ?? result.outputText
      } catch {
        // submit_and_exit returned plain text — strip the acknowledgment prefix if present
        reportMarkdown = result.outputText.replace(/^submit_and_exit acknowledged \([^)]+\):\s*/, "")
      }
      console.log(reportMarkdown)
      if (verbose) {
        // Shows a one line command for merging the new branch in the terminal, if the report contains a new branch to merge.
        const syncBranchName = getSyncBranchNameFromCheckpoint(config)
        const commandLine = `# Sample merge command:
  pushd ${config.workingDir}
     git checkout ${config.fork.branch} && git merge ${syncBranchName} && git branch -D ${syncBranchName} && git push
  popd`
        console.log(commandLine)
      }
    } else {
      // With requireCompletionTool: true this should never happen on a clean run.
      throw new Error("Agent run completed but generate_report was never called (empty output). Check the prompt log for details.")
    }
  } catch (runErr) {
    // Safety net: if the run was aborted due to the context window hard limit AND a
    // checkpoint file exists, generate a partial report instead of crashing with exit 1.
    // Correctif A (reset of lastInputTokens after compaction) should prevent this path in
    // most cases, but this guard handles any remaining edge cases.
    const msg = runErr instanceof Error ? runErr.message : String(runErr)
    const isContextAbort = /context window limit|aborted/i.test(msg)
    if (isContextAbort && existsSync(checkpointPath)) {
      try {
        const cp = JSON.parse(readFileSync(checkpointPath, "utf8")) as {
          syncBranch?: string
          appliedShas?: string[]
          timestamp?: string
        }
        reportMarkdown = buildContextAbortReport({
          upstreamRef,
          forkRef,
          appliedShas: cp.appliedShas ?? [],
          syncBranch: cp.syncBranch ?? "(not created)",
          pendingCommits,
          dryRun: config.sync.dryRun,
        })
        console.error(`\n=== Run complete (context-limit abort) ===\n`)
        console.error("[Context] Run aborted due to context limit — partial report generated; checkpoint preserved for next run.")
        console.log(reportMarkdown)
      } catch {
        // If partial report generation fails, re-throw the original abort error.
        throw runErr
      }
    } else {
      throw runErr
    }
  } finally {
    userInstructionService.stop()

    // Print keypoollive usage summary if any requests were made.
    if (config.models.provider === "keypoollive" && (keypoolStats.totalInputTokens > 0 || keypoolStats.rotations > 0)) {
      const cacheNote = keypoolStats.totalCacheReadTokens > 0
        ? `, ${keypoolStats.totalCacheReadTokens.toLocaleString()} cache-read`
        : ""
      process.stderr.write(
        `\n[Keypool] Run summary:` +
        ` ${keypoolStats.totalInputTokens.toLocaleString()} input${cacheNote}` +
        ` / ${keypoolStats.totalOutputTokens.toLocaleString()} output tokens,` +
        ` ${keypoolStats.rotations} rotation(s),` +
        ` ${keypoolStats.keysUsed.size} key(s) used\n`,
      )
      if (keypoolStats.exhaustions > 0) {
        process.stderr.write(
          `[Keypool] WARNING: ${keypoolStats.exhaustions} exhaustion event(s) — all keys were rate-limited simultaneously.\n`,
        )
      }

      // Generate detailed key usage report and append to reportMarkdown
      if (reportMarkdown) {
        const keyUsageReport = generateKeyUsageReport(keypoolStats)
        const updatedReport = reportMarkdown + "\n\n" + keyUsageReport
        console.log(updatedReport)
      }
    }
  }
}

// Wrap main() in a .catch() handler to ensure the process exits with code 1
// on any unhandled error, rather than crashing with an unhandled rejection.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error("Fatal error:", errorMessage)

    // Enhanced error logging for timeout errors
    const TIMEOUT_ERROR_PATTERNS = [
      /timeout/i,
      /timed out/i,
      /body timeout/i,
      /request timeout/i,
      /socket timeout/i,
      /ETIMEDOUT/i,
      /ESOCKETTIMEDOUT/i,
      /ECONNABORTED/i,
      /deadline exceeded/i,
      /response timeout/i,
      /read timeout/i,
      /connect timeout/i,
    ]

    if (TIMEOUT_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage))) {
      console.error("\n[TIMEOUT DETECTED] This appears to be a timeout error")
      console.error("[TIMEOUT DETECTED] The operation took too long to complete")
      console.error("[TIMEOUT DETECTED] Check the verbose logs above for specific tool/operation details")
      console.error("[TIMEOUT DETECTED] Consider increasing timeout settings or checking network connectivity")
    }

    // Provide stack trace if available and in verbose mode
    if (process.env.VERBOSE === "true" && err instanceof Error && err.stack) {
      console.error("\nStack trace:")
      console.error(err.stack)
    }

    process.exit(1)
  })
```

### `src/reports/context-abort-report.ts`

**Exports:** buildContextAbortReport

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { CandidateCommit } from "../git/git-client.js"

/**
 * Builds a partial sync report when the agent run was aborted due to the context
 * window hard limit being reached before `generate_report` could be called.
 *
 * The checkpoint file preserves any SHAs that were successfully cherry-picked so
 * the next run can resume from where this one stopped.
 */
export function buildContextAbortReport({
  upstreamRef,
  forkRef,
  appliedShas,
  syncBranch,
  pendingCommits,
  dryRun,
}: {
  upstreamRef: string
  forkRef: string
  appliedShas: string[]
  syncBranch: string
  pendingCommits: CandidateCommit[]
  dryRun: boolean
}): string {
  const date = new Date().toISOString()
  const dryRunNote = dryRun ? " [DRY RUN]" : ""

  const appliedSet = new Set(appliedShas.map((s) => s.slice(0, 8)))
  const blocked = pendingCommits.filter((c) => !appliedSet.has(c.sha.slice(0, 8)))

  const lines: string[] = [
    "## Backport Agent — Sync Report (context-limit abort)",
    "",
    `**Date**: ${date}`,
    `**Upstream ref**: \`${upstreamRef}\``,
    `**Fork ref**: \`${forkRef}\``,
    `**Sync branch**: \`${syncBranch}\`${dryRunNote}`,
    "",
    "### Summary",
    "",
    `- ✅ Applied: ${appliedShas.length}`,
    "- ⚠️ Needs human review: 0",
    `- ⛔ Blocked (not attempted): ${blocked.length}`,
    "",
    "> ⚠️ **Run aborted — context window hard limit reached before `generate_report` was called.**",
    "> The checkpoint file has been preserved. The next run will resume from the first unprocessed commit.",
    "",
  ]

  if (appliedShas.length > 0) {
    lines.push("### ✅ Applied commits (from checkpoint)")
    lines.push("")
    for (const sha of appliedShas) {
      const match = pendingCommits.find((c) => c.sha.startsWith(sha.slice(0, 8)))
      const subject = match?.subject ?? "(subject unknown)"
      lines.push(`- \`${sha.slice(0, 8)}\` ${subject}`)
    }
    lines.push("")
  }

  if (blocked.length > 0) {
    lines.push("### ⛔ Blocked commits (deferred to next run)")
    lines.push("")
    for (const c of blocked) {
      lines.push(`- \`${c.sha.slice(0, 8)}\` — context-limit: deferred to next run`)
      lines.push(`  - ${c.subject}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
```

### `src/reports/noop-report.ts`

**Exports:** buildNoopSyncReport

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * Builds the final CLI report for a no-op sync run.
 *
 * This path is used when the upstream branch has no pending commits compared to
 * the fork branch, so the agent runtime is skipped entirely.
 */
export function buildNoopSyncReport({
  upstreamRef,
  forkRef,
  dryRun,
}: {
  upstreamRef: string
  forkRef: string
  dryRun: boolean
}): string {
  const date = new Date().toISOString()

  return [
    "## Backport Agent — Sync Report",
    "",
    `**Date**: ${date}`,
    `**Upstream ref**: \`${upstreamRef}\``,
    `**Fork ref**: \`${forkRef}\``,
    `**Sync branch**: ${dryRun ? "_dry-run (no branch created)_" : "_none (already in sync)_"}`,
    "",
    "### Summary",
    "",
    "- ✅ Applied: 0",
    "- ⚠️ Needs human review: 0",
    "- ⛔ Blocked (not attempted): 0",
    "- ℹ️ No upstream commits were pending; the fork is already in sync.",
    "",
  ].join("\n")
}
```

### `src/reports/report-tools.ts`

**Exports:** CommitResult, makeReportTool

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file reports/report-tools.ts
 *
 * Factory that creates the `generate_report` agent tool.
 *
 * The report tool is the **terminal step** of every sync run: the agent calls it
 * after processing all candidate commits.  Setting `lifecycle: { completesRun: true }`
 * signals to the `@sctg/cline-sdk` runtime that the agent should stop after this
 * tool returns, so the tool doubles as both report generator and run terminator.
 *
 * The tool produces:
 *  - A human-readable **Markdown string** suitable for use as a GitHub PR body.
 *  - A compact **agentState** object that can be embedded in the PR body (hidden
 *    HTML comment) for idempotent re-runs (see `github-tools.ts`).
 *  - Boolean flags `allPassed` and `needsHumanReview` for caller logic.
 *  - A detailed **Markdown file** written to `config.report.destination` combining
 *    the PR-body summary, a Mermaid workflow diagram generated by the fast model,
 *    and a full transcript of every AI sub-agent call from the prompts JSONL log.
 *
 * Report sections (PR body):
 *  1. Header — date, upstream ref, fork ref, sync branch name.
 *  2. Summary — counts of applied / needs-review / blocked commits.
 *  3. Applied commits — listed with risk badges and conflict-resolution notes.
 *  4. Human review required — conflicted or validation-failed commits with reasons.
 *  5. Blocked commits — SHAs that were not attempted at all.
 *  6. Agent decision log — ordered audit trail of key agent decisions.
 *
 * Additional sections (detailed file only):
 *  7. Mermaid workflow diagram — generated by the fast LLM from the run summary.
 *  8. AI sub-agent call log — full prompt/response transcript from the JSONL log.
 */

import { z } from "zod"
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs"
import { resolve as resolvePath, join as joinPath, relative as relativePath } from "node:path"
import { git } from "../git/git-client.js"
import { CHECKPOINT_FILENAME } from "../git/git-tools.js"
import { Agent } from "@sctg/cline-sdk"
import { defineTool } from "../tool-helper.js"
import type { SyncConfig } from "../config/schema.js"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Shape of a single prompt-entry in the `.prompts.jsonl` log file.
 * Extended fields (confidence, guards, hallucinationSuspectsCount…) are
 * optional because they were added progressively — older log files may not
 * carry them.
 */
interface PromptLogEntry {
  type?: "prompt" // absent or "prompt" for backward compat
  timestamp: string
  tool: string
  model: string
  durationMs: number
  prompt: string
  response: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalCost?: number
  // Quality fields added by the improved ai-tools (Improvement 1 / 5 / 6 / 8)
  originalConfidence?: string
  effectiveConfidence?: string
  hasConflictMarkers?: boolean
  syntaxValid?: boolean
  consensusFailure?: boolean
  guards?: string[]
  recommendation?: string
  backportComplexity?: string
  semanticRiskFactorsCount?: number
  hallucinationSuspectsCount?: number
  compatible?: boolean
  affectedCount?: number
  semanticConflictsCount?: number
  fileContentEnriched?: boolean
}

/**
 * Shape of a structured audit event in the `.prompts.jsonl` log file.
 * Audit events are written unconditionally at the tool layer (Improvement 9).
 */
interface AuditEventEntry {
  type: "audit_event"
  timestamp: string
  tool: string
  event: string
  details?: Record<string, unknown>
}

/** Union of all possible JSONL log record shapes. */
type LogEntry = PromptLogEntry | AuditEventEntry

/**
 * Reads the JSONL prompt log, returning prompt entries and audit events separately.
 * Silently skips malformed lines so a corrupt log cannot block the report.
 */
function readPromptLog(logPath: string): { prompts: PromptLogEntry[]; auditEvents: AuditEventEntry[] } {
  if (!existsSync(logPath)) return { prompts: [], auditEvents: [] }
  try {
    const entries = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LogEntry]
        } catch {
          return []
        }
      })
    return {
      prompts: entries.filter((e): e is PromptLogEntry => e.type !== "audit_event"),
      auditEvents: entries.filter((e): e is AuditEventEntry => e.type === "audit_event"),
    }
  } catch {
    return { prompts: [], auditEvents: [] }
  }
}

// Infer the keypoolEventHandler type from Agent's constructor options.
type KeypoolEventHandler = NonNullable<Parameters<typeof Agent>[0]> extends
  { keypoolEventHandler?: (e: infer E) => void } ? ((e: E) => void) : never

/**
 * Instantiates a minimal sub-Agent with no tools for a single reasoning turn.
 * Identical in purpose to the helper in `ai-tools.ts` but local to avoid a
 * cross-module import cycle.
 *
 * @param modelId             - Model identifier to use for the sub-agent.
 * @param systemPrompt        - System prompt to inject.
 * @param providerId          - Provider identifier (e.g. `"openai"`, `"anthropic"`).
 * @param apiKey              - API key for the provider, or `undefined` if using env-based auth.
 * @param keypoolEventHandler - Optional keypool event handler forwarded from the main agent
 *                              so that sub-agent token usage is tracked in keypoolStats.
 */
function makeReportSubAgent(
  modelId: string,
  systemPrompt: string,
  providerId: string,
  apiKey: string | undefined,
  keypoolEventHandler?: KeypoolEventHandler,
): Agent {
  return new Agent({
    providerId,
    modelId,
    apiKey,
    systemPrompt,
    tools: [],
    ...(keypoolEventHandler ? { keypoolEventHandler } : {}),
  })
}

/**
 * Returns a backtick fence string long enough to safely wrap `content`.
 * Finds the longest run of consecutive backticks in the content and uses
 * one more, with a minimum of 3.  This prevents inner ``` from closing the
 * outer fence and breaking Markdown rendering.
 */
function safeFence(content: string): string {
  const maxRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((s) => s.length))
  return "`".repeat(Math.max(3, maxRun + 1))
}

/**
 * Calls the fast model to produce a Mermaid flowchart summarising the agent run.
 * Returns a fenced mermaid code block string, or a fallback placeholder on error.
 *
 * @param config     - Validated `SyncConfig` — used for `models.fast` and `models.provider`.
 * @param runSummary - Compact plain-text description of the completed run.
 * @param providerId - Provider identifier forwarded to the sub-agent.
 * @param apiKey     - API key forwarded to the sub-agent.
 */
async function generateMermaidDiagram(
  config: SyncConfig,
  runSummary: string,
  providerId: string,
  apiKey: string | undefined,
  keypoolEventHandler?: KeypoolEventHandler,
): Promise<string> {
  const systemPrompt = `You are a technical diagram generator. When given a summary of a Git backport agent run, \
produce a single Mermaid flowchart (flowchart TD) that visually represents: \
(1) each candidate commit as a node labelled with its short SHA and subject, \
(2) the risk level applied to each commit (low / medium / high), \
(3) which AI tools were invoked (analyze_commit_for_backport, check_customization_compatibility, resolve_conflict_with_ai), \
(4) the final disposition of each commit (applied ✅, blocked ⛔, needs-review ⚠️, skipped ⟳). \
Use colour-coded styles: applied=green, blocked=red, needs-review=orange, skipped=grey. \
\
IMPORTANT: Always wrap node labels containing parentheses, brackets, or other special Mermaid characters in double quotes. \
For example: "commit123(feat: add feature)" instead of commit123(feat: add feature). \
Output ONLY the raw Mermaid code, no prose, no code fence.`

  const userPrompt = `Agent run summary:\n\n${runSummary}\n\nOutput the Mermaid flowchart now.`

  try {
    const subAgent = makeReportSubAgent(config.models.fast, systemPrompt, providerId, apiKey, keypoolEventHandler)
    const result = await subAgent.run(userPrompt)
    const raw = (result.outputText ?? "").trim()
    // Strip any accidental code fence if the model added one.
    const inner = raw.replace(/^```(?:mermaid)?\n?/i, "").replace(/\n?```$/, "").trim()
    return "```mermaid\n" + inner + "\n```"
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `<!-- Mermaid generation failed: ${msg} -->`
  }
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for the result of processing a single upstream commit.
 *
 * The agent populates one `CommitResult` per candidate commit processed during
 * the run.  These are aggregated by the report tool to produce the final summary.
 */
const CommitResultSchema = z.object({
  /** Full SHA of the upstream commit. */
  sha: z.string(),
  /** Commit subject line (first line of the message). */
  subject: z.string(),
  /** Risk level assigned by `classify_commit_risk`. */
  riskLevel: z.enum(["low", "medium", "high"]),
  /**
   * Final disposition of this commit:
   *  - `"applied"`           — cherry-picked cleanly with no conflicts.
   *  - `"skipped"`           — already applied in the fork (git cherry found equivalent patch).
   *  - `"conflict-resolved"` — had conflicts that the agent resolved automatically.
   *  - `"conflict-blocked"`  — had conflicts the agent could not safely resolve; needs human review.
   *  - `"validation-failed"` — cherry-picked cleanly but the validation suite failed.
   */
  status: z.enum(["applied", "skipped", "conflict-resolved", "conflict-blocked", "validation-failed"]),
  /** Paths of files that had merge conflicts (populated for conflict-* statuses). */
  conflictedFiles: z.array(z.string()).optional(),
  /** Human-readable reasons why this commit needs manual review. */
  humanReviewReasons: z.array(z.string()).optional(),
  /** Per-command validation results, populated when `status === "validation-failed"`. */
  validationResults: z.array(z.object({ command: z.string(), success: z.boolean(), output: z.string() })).optional(),
})

/**
 * TypeScript type for a single commit result, inferred from `CommitResultSchema`.
 */
export type CommitResult = z.infer<typeof CommitResultSchema>

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Builds and returns the `generate_report` agent tool.
 *
 * @param config        - Validated `SyncConfig` — used for model IDs and `report.destination`.
 * @param promptLogPath - Absolute path to the JSONL file written by `logPrompt()` in ai-tools.ts.
 * @param providerId    - Provider identifier used to instantiate sub-agents (e.g. `"openai"`).
 * @param apiKey        - Resolved API key for the provider, or `undefined` if env-based.
 * @returns A single agent tool: `generate_report` (with `completesRun: true`).
 */
export function makeReportTool(
  config: SyncConfig,
  promptLogPath: string,
  providerId: string,
  apiKey: string | undefined,
  keypoolEventHandler?: KeypoolEventHandler,
) {
  return defineTool({
    name: "generate_report",
    description:
      "Generate the final sync report as a Markdown string suitable for a PR body. " +
      "Call this as the LAST step after all commits have been processed. " +
      "Returns the report text AND signals that the agent run is complete.",
    inputSchema: z.object({
      /** Name of the sync branch, or `null` in dry-run mode. */
      syncBranch: z.string().nullable(),
      /** Full ref of the upstream branch, e.g. `"upstream/main"`. */
      upstreamRef: z.string(),
      /** Full ref of the fork branch, e.g. `"origin/main"`. */
      forkRef: z.string(),
      /** Array of per-commit results — one entry per processed candidate. */
      commitResults: z.array(CommitResultSchema),
      /** Commits that were not attempted at all, with mandatory reasons. */
      blockedCommits: z.array(z.object({
        /** Full or abbreviated SHA of the blocked commit. */
        sha: z.string(),
        /** Human-readable reason why this commit was not attempted. */
        reason: z.string().describe("Why this commit was not attempted (AI analysis result, policy, etc.)"),
        /** Risk level from classify_commit_risk, if known. */
        riskLevel: z.enum(["low", "medium", "high"]).optional(),
      })).describe("Commits not attempted, each with a specific reason"),
      /**
       * All SHAs returned by list_candidate_commits — used to detect silently dropped commits.
       * Pass the complete list so the report can cross-check accountability.
       */
      allCandidateShas: z.array(z.string()).optional().describe(
        "Complete list of SHAs from list_candidate_commits, used to detect unaccounted commits"
      ),
      /** Ordered list of key decisions the agent made during this run, for audit purposes. */
      agentDecisions: z.array(z.string()).describe("Audit trail of key decisions made during this run"),
    }),
    // completesRun:true tells the SDK to stop the agent loop after this tool returns.
    lifecycle: { completesRun: true },
    execute: async ({ syncBranch, upstreamRef, forkRef, commitResults, blockedCommits, agentDecisions, allCandidateShas }) => {
      // Remove the within-run checkpoint — the run completed successfully.
      try {
        const checkpointPath = joinPath(config.workingDir, CHECKPOINT_FILENAME)
        if (existsSync(checkpointPath)) unlinkSync(checkpointPath)
      } catch {
        // Non-fatal — checkpoint cleanup failure must not prevent report generation.
      }

      const date = new Date().toISOString()
      const timestampSlug = date.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)

      // --- Partition commits by final status for the summary section ---
      const applied = commitResults.filter((r) => ["applied", "conflict-resolved"].includes(r.status))
      const needsReview = commitResults.filter((r) => ["conflict-blocked", "validation-failed"].includes(r.status))
      const allPassed = needsReview.length === 0

      // --- Accountability check: detect silently dropped commits ---
      const processedShas = new Set([
        ...commitResults.map((r) => r.sha),
        ...blockedCommits.map((c) => c.sha),
      ])
      const unaccounted = (allCandidateShas ?? []).filter(
        (sha) => !processedShas.has(sha) && !processedShas.has(sha.slice(0, 8))
      )

      // --- Build the PR-body Markdown line by line ---
      const prBodyLines: string[] = [
        "## Backport Agent — Sync Report",
        "",
        `**Date**: ${date}`,
        `**Upstream ref**: \`${upstreamRef}\``,
        `**Fork ref**: \`${forkRef}\``,
        `**Sync branch**: ${syncBranch ? `\`${syncBranch}\`` : "_dry-run (no branch created)_"}`,
        "",
        "### Summary",
        "",
        `- ✅ Applied: ${applied.length}`,
        `- ⚠️ Needs human review: ${needsReview.length}`,
        `- ⛔ Blocked (not attempted): ${blockedCommits.length}`,
        ...(unaccounted.length > 0 ? [`- 🔴 Unaccounted (agent bug): ${unaccounted.length}`] : []),
        "",
      ]

      if (applied.length > 0) {
        prBodyLines.push("### Applied commits", "")
        for (const r of applied) {
          const badge = r.status === "conflict-resolved" ? " _(conflict resolved by agent)_" : ""
          prBodyLines.push(`- \`${r.sha.slice(0, 8)}\` [${r.riskLevel}] ${r.subject}${badge}`)
        }
        prBodyLines.push("")
      }

      if (needsReview.length > 0) {
        prBodyLines.push("### ⚠️ Human review required", "")
        for (const r of needsReview) {
          prBodyLines.push(`- \`${r.sha.slice(0, 8)}\` ${r.subject}`)
          if (r.conflictedFiles?.length) prBodyLines.push(`  - Conflicted files: ${r.conflictedFiles.join(", ")}`)
          if (r.humanReviewReasons?.length) {
            for (const reason of r.humanReviewReasons) prBodyLines.push(`  - ${reason}`)
          }
        }
        prBodyLines.push("")
      }

      if (blockedCommits.length > 0) {
        prBodyLines.push("### Blocked commits (not attempted)", "")
        for (const { sha, reason, riskLevel } of blockedCommits) {
          const badge = riskLevel ? ` [${riskLevel}]` : ""
          prBodyLines.push(`- \`${sha.slice(0, 8)}\`${badge} — ${reason}`)
        }
        prBodyLines.push("")
      }

      if (unaccounted.length > 0) {
        prBodyLines.push("### 🔴 Unaccounted commits (agent processing gap)", "")
        for (const sha of unaccounted) prBodyLines.push(`- \`${sha.slice(0, 8)}\` — not processed or reported by agent`)
        prBodyLines.push("")
      }

      if (agentDecisions.length > 0) {
        prBodyLines.push("### Agent decision log", "")
        for (const decision of agentDecisions) prBodyLines.push(`- ${decision}`)
        prBodyLines.push("")
      }

      const report = prBodyLines.join("\n")

      // --- Build the machine-readable state object for idempotent re-runs ---
      const agentState = {
        generatedAt: date,
        appliedShas: applied.map((r) => r.sha),
        blockedShas: blockedCommits.map((c) => c.sha),
        needsReviewShas: needsReview.map((r) => r.sha),
        unaccountedShas: unaccounted,
      }

      // -----------------------------------------------------------------------
      // Detailed report file — combines PR body, Mermaid diagram, and AI call log
      // -----------------------------------------------------------------------

      // Build a compact plain-text run summary for the Mermaid prompt.
      const runSummaryForDiagram = [
        `Upstream: ${upstreamRef}  Fork: ${forkRef}`,
        `Applied (${applied.length}): ${applied.map((r) => `${r.sha.slice(0, 8)} [${r.riskLevel}] ${r.subject}`).join(" | ") || "none"}`,
        `Blocked (${blockedCommits.length}): ${blockedCommits.map((c) => `${c.sha.slice(0, 8)} — ${c.reason}`).join(" | ") || "none"}`,
        `Needs review (${needsReview.length}): ${needsReview.map((r) => r.sha.slice(0, 8)).join(", ") || "none"}`,
        `AI calls: ${readPromptLog(promptLogPath).prompts.map((e) => `${e.tool}(${e.model}, ${e.durationMs}ms)`).join(", ") || "none"}`,
      ].join("\n")

      const mermaidBlock = await generateMermaidDiagram(config, runSummaryForDiagram, providerId, apiKey, keypoolEventHandler)

      // Read and format the prompt log entries.
      const { prompts: promptEntries, auditEvents } = readPromptLog(promptLogPath)

      const detailedLines: string[] = [
        "# Backport Agent — Detailed Run Report",
        "",
        "> This file is generated automatically. It is intended for human analysts and",
        "> AI reasoning models to assess agent performance, decision quality, and LLM behavior.",
        "",
        `**Run timestamp**: ${date}`,
        `**Models used**: fast=\`${config.models.fast}\`  powerful=\`${config.models.powerful}\``,
        `**Prompt log**: \`${promptLogPath}\``,
        "",
        "---",
        "",
        "## Summary (PR body)",
        "",
        report,
        "",
        "---",
        "",
        "## Agent Workflow Diagram",
        "",
        "> Generated by the fast model from the run summary. Evaluate the agent's decision path.",
        "",
        mermaidBlock,
        "",
        "---",
        "",
        `## AI Sub-Agent Call Log (${promptEntries.length} call${promptEntries.length === 1 ? "" : "s"})`,
        "",
        "> Each entry is one sub-agent invocation. Review prompt/response pairs to assess",
        "> reasoning quality, hallucinations, and decision accuracy.",
        "",
      ]

      for (let i = 0; i < promptEntries.length; i++) {
        const e = promptEntries[i]
        const statusBadge = e.error ? "❌ Error" : "✅ OK"
        detailedLines.push(
          `### Call ${i + 1} / ${promptEntries.length} — \`${e.tool}\` ${statusBadge}`,
          "",
          `| Field | Value |`,
          `|---|---|`,
          `| **Timestamp** | ${e.timestamp} |`,
          `| **Tool** | \`${e.tool}\` |`,
          `| **Model** | \`${e.model}\` |`,
          `| **Duration** | ${e.durationMs} ms |`,
          ...(e.inputTokens != null ? [`| **Tokens in** | ${e.inputTokens} |`] : []),
          ...(e.outputTokens != null ? [`| **Tokens out** | ${e.outputTokens} |`] : []),
          ...(e.cacheReadTokens != null && e.cacheReadTokens > 0 ? [`| **Cache read** | ${e.cacheReadTokens} |`] : []),
          ...(e.cacheWriteTokens != null && e.cacheWriteTokens > 0 ? [`| **Cache write** | ${e.cacheWriteTokens} |`] : []),
          ...(e.totalCost != null ? [`| **Cost** | $${e.totalCost.toFixed(6)} |`] : []),
          ...(e.error ? [`| **Error** | ${e.error} |`] : []),
          "",
          "**Prompt sent to sub-agent:**",
          "",
          safeFence(e.prompt),
          e.prompt,
          safeFence(e.prompt),
          "",
          "**Response received:**",
          "",
          safeFence(e.response || "(empty)"),
          e.response || "(empty)",
          safeFence(e.response || "(empty)"),
          "",
          "---",
          "",
        )
      }

      if (promptEntries.length === 0) {
        detailedLines.push("_No AI sub-agent calls were made during this run._", "", "---", "")
      }

      // Performance summary table.
      if (promptEntries.length > 0) {
        const totalMs = promptEntries.reduce((sum, e) => sum + e.durationMs, 0)
        const totalIn = promptEntries.reduce((sum, e) => sum + (e.inputTokens ?? 0), 0)
        const totalOut = promptEntries.reduce((sum, e) => sum + (e.outputTokens ?? 0), 0)
        const totalCost = promptEntries.reduce((sum, e) => sum + (e.totalCost ?? 0), 0)
        const byTool = new Map<string, { count: number; totalMs: number; totalIn: number; totalOut: number }>()
        for (const e of promptEntries) {
          const cur = byTool.get(e.tool) ?? { count: 0, totalMs: 0, totalIn: 0, totalOut: 0 }
          byTool.set(e.tool, {
            count: cur.count + 1,
            totalMs: cur.totalMs + e.durationMs,
            totalIn: cur.totalIn + (e.inputTokens ?? 0),
            totalOut: cur.totalOut + (e.outputTokens ?? 0),
          })
        }
        const hasTokenData = totalIn > 0 || totalOut > 0
        detailedLines.push(
          "## Performance Summary",
          "",
          `**Total AI time**: ${totalMs} ms across ${promptEntries.length} call(s)`,
          ...(hasTokenData ? [
            `**Total input tokens**: ${totalIn}`,
            `**Total output tokens**: ${totalOut}`,
            ...(totalCost > 0 ? [`**Total estimated cost**: $${totalCost.toFixed(6)}`] : []),
          ] : []),
          "",
          hasTokenData
            ? "| Tool | Calls | Total ms | Avg ms | Input tok | Output tok |"
            : "| Tool | Calls | Total ms | Avg ms |",
          hasTokenData ? "|---|---|---|---|---|---|" : "|---|---|---|---|",
          ...[...byTool.entries()].map(
            ([tool, s]) => hasTokenData
              ? `| \`${tool}\` | ${s.count} | ${s.totalMs} | ${Math.round(s.totalMs / s.count)} | ${s.totalIn} | ${s.totalOut} |`
              : `| \`${tool}\` | ${s.count} | ${s.totalMs} | ${Math.round(s.totalMs / s.count)} |`,
          ),
          "",
        )
      }

      // -----------------------------------------------------------------------
      // Decision Quality Metrics section (Improvement 7)
      // -----------------------------------------------------------------------
      {
        // Conflict resolution confidence distribution.
        const conflictCalls = promptEntries.filter((e) => e.tool === "resolve_conflict_with_ai")
        const guardedCalls = conflictCalls.filter((e) => e.guards && (e.guards as string[]).length > 0)
        const markerCalls = conflictCalls.filter((e) => e.hasConflictMarkers)
        const syntaxFailCalls = conflictCalls.filter((e) => e.syntaxValid === false)
        const consensusFailCalls = conflictCalls.filter((e) => e.consensusFailure === true)
        const confidenceDist = { high: 0, medium: 0, low: 0 }
        for (const e of conflictCalls) {
          const c = (e.effectiveConfidence ?? e.originalConfidence ?? "unknown") as string
          if (c === "high" || c === "medium" || c === "low") confidenceDist[c]++
        }

        // Hallucination suspects across analyze calls.
        const analyzeCalls = promptEntries.filter((e) => e.tool === "analyze_commit_for_backport")
        const totalHallucinationSuspects = analyzeCalls.reduce(
          (sum, e) => sum + (e.hallucinationSuspectsCount ?? 0),
          0,
        )

        // Contradiction events from reconcile_ai_assessments audit log.
        const contradictionEvents = auditEvents.filter(
          (e) => e.tool === "reconcile_ai_assessments" && e.event === "contradiction_detected",
        )

        // Compatibility calls enriched with file context.
        const compatCalls = promptEntries.filter((e) => e.tool === "check_customization_compatibility")
        const enrichedCompatCalls = compatCalls.filter((e) => e.fileContentEnriched === true)
        const incompatibleCalls = compatCalls.filter((e) => e.compatible === false)

        detailedLines.push(
          "## Decision Quality Metrics",
          "",
          "> Automated quality signals derived from tool output guards, schema validation,",
          "> hallucination detection, and consensus checks.  Review flagged items manually.",
          "",
        )

        if (conflictCalls.length > 0) {
          detailedLines.push(
            "### Conflict Resolution Quality",
            "",
            `| Metric | Value |`,
            `|---|---|`,
            `| Total conflict resolutions | ${conflictCalls.length} |`,
            `| Confidence: high / medium / low | ${confidenceDist.high} / ${confidenceDist.medium} / ${confidenceDist.low} |`,
            `| Conflict markers detected (guard triggered) | ${markerCalls.length} |`,
            `| Syntax balance failures | ${syntaxFailCalls.length} |`,
            `| Consensus divergences (if enabled) | ${consensusFailCalls.length} |`,
            `| Total guard activations | ${guardedCalls.length} |`,
            "",
          )
          if (guardedCalls.length > 0) {
            detailedLines.push("**Guard details:**", "")
            for (const e of guardedCalls) {
              detailedLines.push(`- \`${e.tool}\` — guards: ${(e.guards as string[]).join(", ")}`)
            }
            detailedLines.push("")
          }
        }

        if (analyzeCalls.length > 0) {
          detailedLines.push(
            "### Commit Analysis Quality",
            "",
            `| Metric | Value |`,
            `|---|---|`,
            `| Total analyze calls | ${analyzeCalls.length} |`,
            `| Commits with semantic risk factors | ${analyzeCalls.filter((e) => (e.semanticRiskFactorsCount ?? 0) > 0).length} |`,
            `| Possible hallucinated references (total) | ${totalHallucinationSuspects} |`,
            "",
          )
        }

        if (compatCalls.length > 0) {
          detailedLines.push(
            "### Compatibility Check Quality",
            "",
            `| Metric | Value |`,
            `|---|---|`,
            `| Total compatibility checks | ${compatCalls.length} |`,
            `| Checks with file content enrichment | ${enrichedCompatCalls.length} |`,
            `| Incompatible results | ${incompatibleCalls.length} |`,
            "",
          )
        }

        if (contradictionEvents.length > 0) {
          detailedLines.push(
            "### ⚠️ AI Assessment Contradictions",
            "",
            `> ${contradictionEvents.length} contradiction(s) were detected by \`reconcile_ai_assessments\`.`,
            "> These are cases where analyze_commit recommended apply but check_customization found issues.",
            "",
          )
          for (const ev of contradictionEvents) {
            const d = ev.details ?? {}
            detailedLines.push(
              `- **SHA**: \`${String(d.sha ?? "?").slice(0, 8)}\`  analyze=\`${d.analyzeRecommendation ?? "?"}\`  ` +
                `compatible=\`${d.compatibilityCompatible ?? "?"}\`  final=\`${d.finalRecommendation ?? "?"}\``,
            )
          }
          detailedLines.push("")
        }

        if (auditEvents.length > 0) {
          detailedLines.push(
            "### Audit Event Timeline",
            "",
            `| Timestamp | Tool | Event | Details |`,
            `|---|---|---|---|`,
            ...auditEvents.map((ev) => {
              const detailStr = ev.details
                ? Object.entries(ev.details)
                    .slice(0, 3)
                    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
                    .join(", ")
                : ""
              return `| ${ev.timestamp.slice(11, 19)} | \`${ev.tool}\` | \`${ev.event}\` | ${detailStr} |`
            }),
            "",
          )
        }
      }

      // Write the detailed report to disk (skipped in dry-run mode).
      if (config.sync.dryRun) {
        process.stderr.write("[Report] Dry-run mode — detailed report not written to disk.\n")
      } else {
        try {
          const destDir = resolvePath(config.workingDir, config.report.destination)
          mkdirSync(destDir, { recursive: true })
          const reportFilename = `report.${timestampSlug}.md`
          const reportFilePath = joinPath(destDir, reportFilename)
          writeFileSync(reportFilePath, detailedLines.join("\n"), "utf8")
          process.stderr.write(`[Report] Detailed report written to: ${reportFilePath}\n`)

          // Commit and push the report file to the sync branch if inside the repo.
          const relPath = relativePath(config.workingDir, reportFilePath)
          if (syncBranch && !relPath.startsWith("..")) {
            git(["add", relPath], config.workingDir)
            git(["commit", "-m", `chore(backport): add run report ${reportFilename}`], config.workingDir)
            git(["push", config.fork.remote, syncBranch], config.workingDir)
            process.stderr.write(`[Report] Report committed and pushed to ${config.fork.remote}/${syncBranch}\n`)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          process.stderr.write(`[Report] Warning: could not write/commit detailed report: ${msg}\n`)
        }
      }

      return { report, agentState, allPassed, needsHumanReview: needsReview.length > 0 }
    },
  })
}

```

### `src/risk/classify-risk.ts`

**Exports:** RiskLevel, CommitRisk, classifyRisk

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file risk/classify-risk.ts
 *
 * Purely deterministic commit risk classifier — no LLM is involved.
 *
 * The classifier assigns one of three risk levels to an upstream commit:
 *  - **low**    — Only touches files that are safe to auto-apply.
 *  - **medium** — Touches shared infrastructure (API layer, shared types, services)
 *                  that may interact with fork customizations.
 *  - **high**   — Touches build configuration, CI pipelines, lockfiles, protobuf
 *                  definitions, or a file explicitly listed in the fork's
 *                  `customizations.yaml`.
 *
 * The LLM agent uses this output as high-level context before deciding whether
 * to attempt a cherry-pick, skip, or request human review.
 *
 * Pattern matching uses `minimatch` (the same glob library used by `.gitignore`
 * and the VS Code extension tree).  All patterns are relative to the repository
 * root, as returned by `git diff-tree --name-only`.
 */

import { minimatch } from "minimatch"
import type { Customizations } from "../customizations/schema.js"

/**
 * The three risk levels assigned to every upstream commit.
 *
 *  - `"low"`    Safe to cherry-pick with minimal validation.
 *  - `"medium"` Requires standard validation suite before merging.
 *  - `"high"`   Requires full validation + likely human review.
 */
export type RiskLevel = "low" | "medium" | "high"

/**
 * Full risk assessment result for a single upstream commit.
 */
export type CommitRisk = {
  /** The commit SHA that was classified. */
  sha: string
  /** Computed risk level: "low", "medium", or "high". */
  level: RiskLevel
  /** Human-readable explanations for why each risk factor was triggered. */
  reasons: string[]
  /** `true` if any file in the commit matches a customization zone in the fork. */
  touchesCustomization: boolean
  /** IDs of `CustomizationEntry` objects whose paths were matched by this commit. */
  customizationIds: string[]
  /**
   * Union of `testCommands` from all `CustomizationEntry` objects matched by this
   * commit.  The agent should pass these as `extraCommands` to `run_validation`
   * when validating a high-risk commit that touches customization zones.
   * Empty array when no customization defines `testCommands` or when risk is low/medium.
   */
  testCommands: string[]
}

/**
 * Glob patterns whose matches unconditionally elevate risk to `"high"`.
 *
 * These patterns are intentionally generic so the classifier works for any
 * repository layout (single-package, monorepo, multi-language, etc.).
 *
 *  - Root-level dependency manifests and lockfiles
 *  - CI / GitHub Actions / GitLab / CircleCI pipelines
 *  - Build scripts directory (scripts/**)
 *  - TypeScript project references (tsconfig*.json)
 *  - ESBuild config files (esbuild.*)
 *  - Protobuf/schema definitions anywhere in the tree (glob: ** /proto/**)
 *
 * Fork-specific paths (e.g. custom source directories, generated assets) should
 * be declared in `customizations.yaml` — the classifier always checks those first.
 */
const HIGH_RISK_PATTERNS = [
  // Root-level package manifests and lockfiles
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  // CI / CD pipelines
  ".github/workflows/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  // Build tooling
  "scripts/**",
  "esbuild.*",
  "tsconfig*.json",
  // Schema/proto definitions (matches at any depth)
  "**/proto/**",
]

/**
 * Glob patterns whose matches elevate risk to `"medium"` when no high-risk
 * pattern has already been matched.
 *
 * These generic patterns capture shared infrastructure that commonly conflicts
 * with fork customizations across different project layouts (API layers,
 * shared types, services, and provider registries at any depth).
 */
const MEDIUM_RISK_PATTERNS = [
  "**/src/core/api/**",
  "**/src/shared/**",
  "**/src/services/**",
  "**/src/providers/**",
  "**/src/api/**",
]

/**
 * Classifies the risk level of an upstream commit based on which files it changes.
 *
 * Evaluation order (highest-priority first):
 *  1. Fork customization zones (`customizations.yaml`) → always `high`.
 *  2. `HIGH_RISK_PATTERNS` glob matches                → always `high`.
 *  3. `MEDIUM_RISK_PATTERNS` glob matches              → `medium` (if not already high).
 *  4. Detected file deletions or renames               → elevate to at least `medium`.
 *  5. No matches                                        → remains `low`.
 *
 * This function is **pure and deterministic** — given the same inputs it always
 * returns the same output.  It has no side effects and performs no I/O.
 *
 * @param sha             - Full or abbreviated commit SHA (used to label the result).
 * @param changedFiles    - Repository-relative file paths changed by the commit,
 *                          as returned by `getCommitChangedFiles`.
 * @param customizations  - Validated customizations manifest from `loadCustomizations`.
 * @returns A `CommitRisk` record with the computed level, reasons, and customization matches.
 */
export function classifyRisk(sha: string, changedFiles: string[], customizations: Customizations): CommitRisk {
  const reasons: string[] = []
  const matchedCustomizationIds: string[] = []
  const matchedTestCommands: string[] = []
  let level: RiskLevel = "low"

  // --- Step 1: Check fork customization zones ---
  // Any file that matches a customization's glob pattern triggers high risk,
  // because it means an upstream change directly conflicts with our fork-specific code.
  // Strip DELETE:/RENAME: prefixes before glob matching so patterns work correctly
  // regardless of how the file was changed; the prefix is only meaningful for step 4.
  for (const entry of customizations.customizations) {
    const hits = changedFiles.filter((f) =>
      entry.paths.some((p) => minimatch(f.replace(/^(?:DELETE:|RENAME:)/, ""), p)),
    )
    if (hits.length > 0) {
      matchedCustomizationIds.push(entry.id)
      reasons.push(`Touches customization "${entry.id}": ${hits.join(", ")}`)
      level = "high"
      // Collect per-customization test commands for later injection into run_validation.
      if (entry.testCommands) {
        matchedTestCommands.push(...entry.testCommands)
      }
    }
  }

  // --- Step 2: Check high-risk file patterns ---
  // Build infrastructure changes (lockfiles, CI, tsconfig, proto) are always high risk
  // regardless of whether they touch a named customization zone.
  for (const pattern of HIGH_RISK_PATTERNS) {
    const hits = changedFiles.filter((f) => minimatch(f.replace(/^(?:DELETE:|RENAME:)/, ""), pattern))
    if (hits.length > 0) {
      if (level !== "high") level = "high"
      reasons.push(`High-risk file pattern "${pattern}": ${hits.join(", ")}`)
    }
  }

  // --- Step 3: Check medium-risk patterns (only if still low) ---
  // These patterns are checked last so that a high-risk determination from steps 1-2
  // is not overwritten.  A medium classification means the agent should run the
  // standard validation suite but may still auto-apply.
  if (level === "low") {
    for (const pattern of MEDIUM_RISK_PATTERNS) {
      const hits = changedFiles.filter((f) => minimatch(f.replace(/^(?:DELETE:|RENAME:)/, ""), pattern))
      if (hits.length > 0) {
        level = "medium"
        reasons.push(`Medium-risk pattern "${pattern}": ${hits.join(", ")}`)
      }
    }
  }

  // --- Step 4: Deletions and renames ---
  // Removing or renaming files is inherently risky because dependent code may break.
  // Elevate to at least medium if not already high.
  const deletions = changedFiles.filter((f) => f.startsWith("DELETE:") || f.startsWith("RENAME:"))
  if (deletions.length > 0) {
    if (level === "low") level = "medium"
    reasons.push(`File deletions or renames detected`)
  }

  // --- Step 5: Fallback reason ---
  // Always include at least one reason so callers don't have to handle an empty array.
  if (reasons.length === 0) {
    reasons.push("No risk patterns matched — appears to be a low-risk change")
  }

  return {
    sha,
    level,
    reasons,
    touchesCustomization: matchedCustomizationIds.length > 0,
    customizationIds: matchedCustomizationIds,
    // Deduplicate in case the same command appears in multiple customization entries.
    testCommands: [...new Set(matchedTestCommands)],
  }
}
```

### `src/risk/risk-tools.ts`

**Exports:** makeRiskTool

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file risk/risk-tools.ts
 *
 * Factory that creates the `classify_commit_risk` agent tool.
 *
 * Risk classification is a deterministic gate that runs **before** any LLM
 * reasoning: the agent calls this tool first, learns the risk level and
 * affected customizations, then decides how to proceed (auto-apply, apply with
 * validation, or escalate to human review).
 *
 * The tool is kept in a separate factory function so that the validated
 * `customizations` object (loaded once at startup) can be captured by closure
 * and reused across every invocation without re-parsing the YAML file.
 */

import { z } from "zod"
import { defineTool } from "../tool-helper.js"
import { classifyRisk } from "./classify-risk.js"
import { getCommitChangedFiles } from "../git/git-client.js"
import type { SyncConfig } from "../config/schema.js"
import type { Customizations } from "../customizations/schema.js"

/**
 * Builds and returns the `classify_commit_risk` agent tool.
 *
 * The tool is pre-bound to `config` and `customizations` so that callers only
 * need to provide the commit SHA at invocation time.
 *
 * @param config          - Validated `SyncConfig` (provides `workingDir`).
 * @param customizations  - Validated customizations manifest (provides zone definitions).
 * @returns A single agent tool: `classify_commit_risk`.
 */
export function makeRiskTool(config: SyncConfig, customizations: Customizations) {
  return defineTool({
    name: "classify_commit_risk",
    description:
      "Classify the risk level of an upstream commit by analysing which files it changes. " +
      "Returns 'low', 'medium', or 'high' with human-readable reasons. " +
      "High risk means the commit touches fork customization zones or build-critical files. " +
      "This is a deterministic check — no LLM is used here.",
    inputSchema: z.object({
      /** Full or abbreviated SHA of the upstream commit to classify. */
      sha: z.string().describe("Upstream commit SHA to classify"),
    }),
    execute: async ({ sha }) => {
      // 1. Retrieve the list of paths changed by this commit from git.
      const changedFiles = getCommitChangedFiles(config.workingDir, sha)
      // 2. Run the deterministic pattern matcher against those paths.
      const risk = classifyRisk(sha, changedFiles, customizations)
      // The full CommitRisk object is returned to the agent as tool output.
      return risk
    },
  })
}
```

### `src/tool-helper.ts`

**Exports:** defineTool

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file tool-helper.ts
 *
 * Typed wrapper around `createTool` from `@sctg/cline-sdk`.
 *
 * **Problem — overload resolution ambiguity:**
 * `@sctg/cline-shared/dist/tools/create.d.ts` declares two overloads of
 * `createTool`:
 *  1. `createTool(config: { inputSchema: Record<string, unknown>, ... })`
 *  2. `createTool<TSchema extends ZodTypeAny, TOutput>(config: { inputSchema: TSchema, ... })`
 *
 * TypeScript evaluates overloads in declaration order.  Because `ZodObject`
 * is structurally assignable to `Record<string, unknown>`, overload 1 always
 * wins, and the inferred input type in `execute` becomes `unknown` instead of
 * the typed schema inference from overload 2.
 *
 * **Solution:**
 * `defineTool` has the correct generic signature (overload 2's types) and casts
 * the config to `any` before forwarding to `createTool`.  TypeScript then
 * infers the Zod-typed `execute` parameter correctly at every call site.
 *
 * This is the only place where `as any` is used in the codebase.
 */

import { createTool } from "@sctg/cline-agents"
import type { AgentTool, AgentToolContext } from "@sctg/cline-sdk"
import { z } from "zod"

/**
 * Creates a fully-typed agent tool from the provided configuration.
 *
 * This is a thin wrapper around `createTool` that exists solely to fix TypeScript
 * overload resolution.  All arguments are forwarded unchanged; the only difference
 * from calling `createTool` directly is that `TSchema` is correctly inferred from
 * `inputSchema`.
 *
 * @typeParam TSchema - Zod schema type for the tool's input object.
 * @typeParam TOutput - Return type of the `execute` function.
 *
 * @param config - Tool configuration object.
 * @param config.name        - Machine-readable tool name (snake_case by convention).
 * @param config.description - Natural-language description shown to the LLM.
 * @param config.inputSchema - Zod schema that validates and types the tool's input.
 * @param config.execute     - Async function called by the agent runtime.  Receives
 *                             a fully typed `input` (inferred from `TSchema`) and
 *                             an `AgentToolContext` for runtime metadata.
 * @param config.lifecycle   - Optional lifecycle hooks (e.g. `completesRun: true`).
 * @param config.timeoutMs   - Optional per-invocation timeout in milliseconds.
 * @param config.retryable   - Whether the runtime should retry on transient failure.
 * @param config.maxRetries  - Maximum retry attempts (used when `retryable` is `true`).
 * @returns A fully constructed `AgentTool` ready to be passed to the `Agent` constructor.
 */
export function defineTool<TSchema extends z.ZodTypeAny, TOutput>(config: {
  name: string
  description: string
  inputSchema: TSchema
  execute: (input: z.infer<TSchema>, context: AgentToolContext) => Promise<TOutput>
  lifecycle?: AgentTool<z.infer<TSchema>, TOutput>["lifecycle"]
  timeoutMs?: number
  retryable?: boolean
  maxRetries?: number
}): AgentTool<z.infer<TSchema>, TOutput> {
  // Cast to `any` to bypass the overload ambiguity described above.
  // The return type annotation ensures callers still get full type safety.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createTool(config as any)
}
```

### `src/tools/benchmark-replay.ts`

```typescript
#!/usr/bin/env tsx
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file tools/benchmark-replay.ts
 *
 * **Benchmark Replay** — Improvement 11
 *
 * Replays all AI sub-agent calls recorded in a `.prompts.jsonl` run log using
 * an alternative model, then produces a side-by-side comparison report that
 * shows how the new model's outputs differ from the original.
 *
 * This lets you compare two models (e.g. `mistral/devstral-latest` vs
 * `anthropic/claude-sonnet-4-5`) without running a full sync against a real
 * repository.  The JSONL log contains every prompt verbatim, so replays are
 * perfectly reproducible.
 *
 * **Usage:**
 *
 * ```bash
 * # Compare the last run log with a different model
 * npx tsx src/tools/benchmark-replay.ts \
 *   --log run-1780060224987.prompts.jsonl \
 *   --model anthropic/claude-sonnet-4-5 \
 *   --provider anthropic \
 *   --api-key $ANTHROPIC_API_KEY
 *
 * # Or pipe provider config from a config.json
 * npx tsx src/tools/benchmark-replay.ts \
 *   --log run-1780060224987.prompts.jsonl \
 *   --model anthropic/claude-sonnet-4-5 \
 *   --config ./config.json
 * ```
 *
 * The comparison report is written to stdout (redirect to a file as needed).
 * Set `VERBOSE=true` to also see per-call diffs on stderr.
 *
 * **Exit codes:**
 *  - `0` — Replay completed (some calls may have failed; check the report).
 *  - `1` — Fatal error (missing arguments, unreadable log file).
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { Agent } from "@sctg/cline-sdk"

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  logPath: string
  model: string
  provider: string
  apiKey: string | undefined
  configPath: string | undefined
} {
  const args = argv.slice(2)
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
  }

  const logPath = get("--log")
  const model = get("--model")
  const configPath = get("--config")

  if (!logPath) {
    process.stderr.write("Error: --log <path> is required\n")
    process.stderr.write(
      "Usage: npx tsx src/tools/benchmark-replay.ts --log <run.prompts.jsonl> --model <modelId> [--provider <id>] [--api-key <key>] [--config <config.json>]\n",
    )
    process.exit(1)
  }
  if (!model) {
    process.stderr.write("Error: --model <modelId> is required\n")
    process.exit(1)
  }

  // Resolve provider and API key from CLI flags or config file.
  let provider = get("--provider")
  let apiKey = get("--api-key")

  if (configPath) {
    try {
      const cfg = JSON.parse(readFileSync(resolvePath(configPath), "utf8")) as {
        models?: { provider?: string; apiKey?: string }
      }
      if (!provider) provider = cfg.models?.provider
      if (!apiKey && cfg.models?.apiKey && !cfg.models.apiKey.startsWith("$")) {
        apiKey = cfg.models.apiKey
      }
    } catch (e) {
      process.stderr.write(`Warning: could not read config file ${configPath}: ${e}\n`)
    }
  }

  if (!provider) {
    process.stderr.write("Error: --provider <id> is required (or provide --config with models.provider)\n")
    process.exit(1)
  }

  return { logPath: resolvePath(logPath), model, provider, apiKey, configPath }
}

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

interface PromptEntry {
  type?: string
  timestamp: string
  tool: string
  model: string
  durationMs: number
  prompt: string
  response: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  recommendation?: string
  effectiveConfidence?: string
}

function readPromptEntries(logPath: string): PromptEntry[] {
  if (!existsSync(logPath)) {
    process.stderr.write(`Error: log file not found: ${logPath}\n`)
    process.exit(1)
  }
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as PromptEntry
        // Skip audit events — only replay actual LLM prompts.
        if (parsed.type === "audit_event") return []
        // Skip consensus entries to avoid inflating replay cost.
        if (parsed.tool?.includes(":consensus")) return []
        return [parsed]
      } catch {
        return []
      }
    })
}

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

function computeLineSimilarity(a: string, b: string): number {
  const linesA = new Set(a.split("\n").map((l) => l.trim()).filter(Boolean))
  const linesB = new Set(b.split("\n").map((l) => l.trim()).filter(Boolean))
  const common = [...linesA].filter((l) => linesB.has(l)).length
  const total = linesA.size + linesB.size
  return total === 0 ? 1 : (2 * common) / total
}

function extractJson(text: string): unknown {
  const m1 = text.match(/```json\s*([\s\S]*?)```/)
  if (m1) return JSON.parse(m1[1].trim())
  const m2 = text.match(/```\s*([\s\S]*?)```/)
  if (m2) return JSON.parse(m2[1].trim())
  const m3 = text.match(/\{[\s\S]*\}/)
  if (m3) return JSON.parse(m3[0])
  return JSON.parse(text.trim())
}

// ---------------------------------------------------------------------------
// Replay logic
// ---------------------------------------------------------------------------

interface ReplayResult {
  callIndex: number
  tool: string
  originalModel: string
  replayModel: string
  originalResponse: string
  replayResponse: string
  originalDurationMs: number
  replayDurationMs: number
  similarity: number
  originalRecommendation?: string
  replayRecommendation?: string
  replayError?: string
}

async function replayCall(
  entry: PromptEntry,
  callIndex: number,
  replayModel: string,
  provider: string,
  apiKey: string | undefined,
): Promise<ReplayResult> {
  const replayAgent = new Agent({
    providerId: provider,
    modelId: replayModel,
    apiKey,
    systemPrompt: "",
    tools: [],
  })

  const t0 = Date.now()
  let replayResponse = ""
  let replayError: string | undefined

  try {
    const result = await replayAgent.run(entry.prompt)
    replayResponse = result.outputText ?? ""
  } catch (err) {
    replayError = err instanceof Error ? err.message : String(err)
  }
  const replayDurationMs = Date.now() - t0

  const similarity = replayError ? 0 : computeLineSimilarity(entry.response, replayResponse)

  // Try to extract recommendation/confidence from both responses for comparison.
  let originalRecommendation: string | undefined = entry.recommendation
  let replayRecommendation: string | undefined
  if (!replayError) {
    try {
      const parsed = extractJson(replayResponse) as Record<string, unknown>
      replayRecommendation =
        (parsed.recommendation as string) ??
        (parsed.confidence as string) ??
        (parsed.compatible != null ? String(parsed.compatible) : undefined)
      if (!originalRecommendation) {
        const orig = extractJson(entry.response) as Record<string, unknown>
        originalRecommendation =
          (orig.recommendation as string) ??
          (orig.confidence as string) ??
          (orig.compatible != null ? String(orig.compatible) : undefined)
      }
    } catch {
      // Non-JSON responses — comparison is similarity-only.
    }
  }

  return {
    callIndex,
    tool: entry.tool,
    originalModel: entry.model,
    replayModel,
    originalResponse: entry.response,
    replayResponse,
    originalDurationMs: entry.durationMs,
    replayDurationMs,
    similarity,
    originalRecommendation,
    replayRecommendation,
    replayError,
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function buildReport(
  logPath: string,
  replayModel: string,
  entries: PromptEntry[],
  results: ReplayResult[],
): string {
  const date = new Date().toISOString()
  const lines: string[] = [
    "# Backport Agent — Benchmark Replay Report",
    "",
    `**Date**: ${date}`,
    `**Source log**: \`${logPath}\``,
    `**Original calls**: ${entries.length}`,
    `**Replay model**: \`${replayModel}\``,
    "",
    "---",
    "",
    "## Summary",
    "",
  ]

  const succeeded = results.filter((r) => !r.replayError)
  const failed = results.filter((r) => r.replayError)
  const avgSim = succeeded.length > 0
    ? succeeded.reduce((s, r) => s + r.similarity, 0) / succeeded.length
    : 0
  const lowSimCount = succeeded.filter((r) => r.similarity < 0.5).length
  const decisionMismatches = succeeded.filter(
    (r) => r.originalRecommendation && r.replayRecommendation && r.originalRecommendation !== r.replayRecommendation,
  )

  lines.push(
    `| Metric | Value |`,
    `|---|---|`,
    `| Calls replayed | ${succeeded.length} / ${entries.length} |`,
    `| Replay errors | ${failed.length} |`,
    `| Average line similarity | ${(avgSim * 100).toFixed(1)} % |`,
    `| Low-similarity calls (< 50 %) | ${lowSimCount} |`,
    `| Decision mismatches | ${decisionMismatches.length} |`,
    "",
  )

  if (decisionMismatches.length > 0) {
    lines.push("### ⚠️ Decision Mismatches", "")
    for (const r of decisionMismatches) {
      lines.push(
        `- Call ${r.callIndex + 1} (\`${r.tool}\`): original=\`${r.originalRecommendation}\` → replay=\`${r.replayRecommendation}\``,
      )
    }
    lines.push("")
  }

  lines.push("---", "", "## Per-Call Comparison", "")

  for (const r of results) {
    const badge = r.replayError ? "❌" : r.similarity >= 0.7 ? "✅" : r.similarity >= 0.4 ? "⚠️" : "🔴"
    lines.push(
      `### Call ${r.callIndex + 1} \`${r.tool}\` ${badge}`,
      "",
      `| Field | Original | Replay |`,
      `|---|---|---|`,
      `| Model | \`${r.originalModel}\` | \`${r.replayModel}\` |`,
      `| Duration ms | ${r.originalDurationMs} | ${r.replayDurationMs} |`,
      ...(r.originalRecommendation || r.replayRecommendation
        ? [`| Decision | \`${r.originalRecommendation ?? "—"}\` | \`${r.replayRecommendation ?? "—"}\` |`]
        : []),
      ...(!r.replayError ? [`| Line similarity | — | ${(r.similarity * 100).toFixed(1)} % |`] : []),
      ...(r.replayError ? [`| Error | — | ${r.replayError} |`] : []),
      "",
    )
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { logPath, model, provider, apiKey } = parseArgs(process.argv)

  const entries = readPromptEntries(logPath)
  if (entries.length === 0) {
    process.stderr.write("No prompt entries found in log file (only audit events or empty file).\n")
    process.exit(1)
  }

  const verbose = process.env.VERBOSE === "true"
  process.stderr.write(
    `[Replay] ${entries.length} call(s) to replay with model \`${model}\` via provider \`${provider}\`\n`,
  )

  const results: ReplayResult[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    process.stderr.write(`[Replay] ${i + 1}/${entries.length} \`${entry.tool}\` (${entry.model} → ${model})…\n`)
    const result = await replayCall(entry, i, model, provider, apiKey)
    results.push(result)
    if (verbose) {
      process.stderr.write(
        `[Replay] similarity=${(result.similarity * 100).toFixed(1)}%` +
          (result.replayError ? ` ERROR: ${result.replayError}` : "") +
          "\n",
      )
    }
  }

  const report = buildReport(logPath, model, entries, results)
  process.stdout.write(report + "\n")
}

main().catch((err) => {
  process.stderr.write(`[Replay] Fatal: ${err}\n`)
  process.exit(1)
})
```

### `src/validation/commands.ts`

**Exports:** CommandResult, ALLOWED_COMMAND_PREFIXES, isAllowedCommand, runValidationCommand, runValidationSuite, runShellCommand, runTrustedSuite

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file validation/commands.ts
 *
 * Allowlist-based command runner for the validation suite.
 *
 * **Security model:**
 * The LLM agent may suggest commands to run during validation.  To prevent
 * arbitrary code execution, every command is checked against a fixed prefix
 * allowlist before being executed.  Only standard package-manager test scripts
 * and well-known CLI tools are permitted.  The allowlist is hard-coded in this
 * file and cannot be extended by the agent at runtime.
 *
 * **No shell interpolation:**
 * Commands are tokenized with a quote-aware splitter (`splitCommand`) and
 * executed via `execFileSync(bin, args[])` (not through a shell).  This
 * preserves arguments that contain spaces when wrapped in single or double
 * quotes, and prevents shell metacharacter injection for allowlisted commands.
 *
 * **Failure fast:**
 * `runValidationSuite` stops at the first failing command so that the agent
 * receives a clear, actionable error rather than a wall of cascading output.
 */

import { execFileSync, spawnSync } from "node:child_process"

/**
 * Result of running a single validation command.
 */
export type CommandResult = {
  /** The original command string that was (attempted to be) executed. */
  command: string
  /** `true` if the command exited with code 0. */
  success: boolean
  /** Process exit code.  `1` is used when the command was blocked by the allowlist. */
  exitCode: number
  /** Combined stdout + stderr output from the process (or the block reason). */
  output: string
}

/**
 * Hard-coded allowlist of command prefixes that the agent is permitted to execute.
 *
 * A command is allowed if and only if it starts with one of these strings.
 * The list is intentionally conservative:
 *  - `"npm run "`     — npm scripts defined in package.json
 *  - `"pnpm run "`    — pnpm equivalent
 *  - `"yarn run "`    — yarn equivalent
 *  - `"npx tsc"`      — TypeScript type-checker
 *  - `"npx eslint"`   — ESLint linter
 *  - `"npx vitest"`   — Vitest unit test runner
 *  - `"node --version"` — Non-destructive version probe (useful for diagnostics)
 */
export const ALLOWED_COMMAND_PREFIXES = [
  "npm run ",
  "pnpm run ",
  "yarn run ",
  "bun run ",
  "bun install",
  "npx tsc",
  "npx eslint",
  "npx vitest",
  "node --version",
]

/**
 * Splits a command string into tokens, respecting single and double quotes so
 * that arguments containing spaces are treated as a single token.
 *
 * Examples:
 *  - `"npm run typecheck"` → `["npm", "run", "typecheck"]`
 *  - `"npx eslint src --rule 'no-console: error'"` → `["npx", "eslint", "src", "--rule", "no-console: error"]`
 *
 * Escape sequences inside quotes are intentionally not supported because the
 * allowlist only permits a narrow, well-known set of commands.
 *
 * @param command - Raw command string as provided by the agent.
 * @returns Array of string tokens: `[binary, ...args]`.
 */
function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  for (const ch of command) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        parts.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return parts
}


/**
 * Returns `true` if the command starts with an allowlisted prefix.
 *
 * The check is intentionally a simple `startsWith` — it does not parse the
 * full command.  This makes the allowlist easy to audit.
 *
 * @param command - The full command string to check.
 * @returns `true` if the command is allowed, `false` if it should be blocked.
 */
export function isAllowedCommand(command: string): boolean {
  return ALLOWED_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix))
}

/**
 * Runs a single validation command and returns its result.
 *
 * If the command is not on the allowlist, it is immediately blocked and a
 * descriptive error is returned without executing anything.
 *
 * Execution details:
 *  - `stdio: ["pipe","pipe","pipe"]` — all streams are captured, not printed.
 *  - `timeout: 120_000` ms — commands are killed if they take more than 2 minutes.
 *  - No `shell: true` — the command is parsed by whitespace split and executed directly.
 *
 * @param command - Full command string, e.g. `"npm run typecheck"`.
 * @param cwd     - Absolute working directory in which to run the command.
 * @returns A `CommandResult` with the success flag, exit code, and captured output.
 */
export function runValidationCommand(command: string, cwd: string): CommandResult {
  // Security gate: reject any command not matching the allowlist.
  if (!isAllowedCommand(command)) {
    // Log to stderr if verbose mode is enabled
    if (process.env.VERBOSE === "true") {
      process.stderr.write(`[VERBOSE] Command rejected by isAllowedCommand: "${command}"\n`)
    }

    return {
      command,
      success: false,
      exitCode: 1,
      output: `Blocked: command "${command}" is not in the allowed list`,
    }
  }

  // Split into [binary, ...args] using a quote-aware tokenizer so that arguments
  // containing spaces (wrapped in quotes) are preserved as single tokens.
  // Commands are then executed via execFileSync without a shell, preventing
  // metacharacter injection.
  const parts = splitCommand(command)
  const bin = parts[0]
  const args = parts.slice(1)

  try {
    const output = execFileSync(bin, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      // 2-minute safety timeout — prevents hung test runners from blocking the agent.
      timeout: 120_000,
    })
    return { command, success: true, exitCode: 0, output }
  } catch (err: unknown) {
    // execFileSync throws when the process exits non-zero.  Extract diagnostic info.
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string }
    // Combine all output streams for maximum debuggability.
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n")
    return { command, success: false, exitCode: e.status ?? 1, output }
  }
}

/**
 * Runs an ordered list of validation commands, stopping on the first failure.
 *
 * "Fail fast" semantics are intentional: the agent should see the first broken
 * command and address it rather than drowning in cascading failures.
 *
 * @param commands - Ordered array of command strings to execute.
 * @param cwd      - Absolute working directory for all commands.
 * @returns Array of `CommandResult` objects, one per executed command.
 *          If a command fails, no subsequent commands are executed.
 */
export function runValidationSuite(commands: string[], cwd: string): CommandResult[] {
  const results: CommandResult[] = []
  for (const command of commands) {
    const result = runValidationCommand(command, cwd)
    results.push(result)
    // Stop on first failure — no point running further checks.
    if (!result.success) break
  }
  return results
}

/**
 * Runs a single shell command from the config without any allowlist check.
 *
 * This is used for developer-defined commands in `config.validation.*` (low, medium,
 * high, final).  Because these commands originate from a trusted config file (not from
 * the LLM), they bypass the prefix allowlist and are executed via `bash -c` so that
 * compound syntax (`cd dir && cmd`, `pushd`/`popd`, pipes, semicolons…) works correctly.
 *
 * The 5-minute timeout is generous enough for full build steps (VSIX packaging, etc.).
 *
 * @param command - Shell command string, e.g. `"cd apps/vscode && bun install"`.
 * @param cwd     - Absolute working directory passed to bash.
 * @returns A `CommandResult` indicating success/failure and captured output.
 */
export function runShellCommand(command: string, cwd: string): CommandResult {
  const result = spawnSync("bash", ["-c", command], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 300_000,
  })

  if (result.error) {
    return {
      command,
      success: false,
      exitCode: 1,
      output: result.error.message,
    }
  }

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n")
  const exitCode = result.status ?? 1
  return { command, success: exitCode === 0, exitCode, output }
}

/**
 * Runs an ordered list of trusted (config-defined) shell commands via `bash -c`.
 *
 * Uses the same fail-fast semantics as `runValidationSuite` but calls `runShellCommand`
 * instead of the allowlisted runner, so compound commands are fully supported.
 *
 * @param commands - Ordered array of shell command strings.
 * @param cwd      - Absolute working directory for all commands.
 * @returns Array of `CommandResult` objects, stopping on the first failure.
 */
export function runTrustedSuite(commands: string[], cwd: string): CommandResult[] {
  const results: CommandResult[] = []
  for (const command of commands) {
    const result = runShellCommand(command, cwd)
    results.push(result)
    if (!result.success) break
  }
  return results
}
```

### `src/validation/validation-tools.ts`

**Exports:** makeValidationTool

```typescript
// Copyright (c) 2026 Ronan Le Meillat - SCTG Development
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * @file validation/validation-tools.ts
 *
 * Factory that creates the `run_validation` agent tool.
 *
 * Validation is the agent's safety net: before accepting a cherry-picked commit
 * as "done", the agent runs the suite appropriate for the commit's risk level to
 * confirm that the fork still builds and passes tests.
 *
 * Risk → suite mapping (configured in `config.validation`):
 *  - `"low"`    → `config.validation.low`    (e.g. only typecheck)
 *  - `"medium"` → `config.validation.medium` (e.g. typecheck + unit tests)
 *  - `"high"`   → `config.validation.high`   (e.g. full build + integration tests)
 *
 * The agent may append extra customization-specific commands via the
 * `extraCommands` input field.  All commands (base suite + extras) are passed
 * through the same `ALLOWED_COMMAND_PREFIXES` allowlist in `commands.ts`.
 */

import { z } from "zod"
import { defineTool } from "../tool-helper.js"
import { runTrustedSuite, runValidationSuite } from "./commands.js"
import type { SyncConfig } from "../config/schema.js"
import type { RiskLevel } from "../risk/classify-risk.js"

/**
 * Builds and returns the `run_validation` agent tool.
 *
 * The tool is pre-bound to `config` so that the caller only needs to supply the
 * risk level and any optional extra commands at invocation time.
 *
 * @param config - Validated `SyncConfig` (provides `workingDir` and `validation` suites).
 * @returns A single agent tool: `run_validation`.
 */
export function makeValidationTool(config: SyncConfig) {
  return defineTool({
    name: "run_validation",
    description:
      "Run the validation suite appropriate for a given risk level. " +
      "'low' runs only typecheck. 'medium' adds unit tests. 'high' adds build and integration tests. " +
      "'final' runs the comprehensive end-to-end build suite from config.validation.final (call this once after all commits are processed). " +
      "Config-defined commands run via bash; LLM-supplied extraCommands are subject to the prefix allowlist. " +
      "Returns success status and per-command output.",
    inputSchema: z.object({
      /** Risk level computed by `classify_commit_risk`, or "final" for the end-to-end build suite. */
      riskLevel: z.enum(["low", "medium", "high", "final"]).describe("Risk level determines which suite to run; use 'final' for the comprehensive end-to-end build check"),
      /**
       * Optional additional commands to append to the standard suite.
       * Useful for customization-specific verification commands listed in
       * `customizations.yaml` under `testCommands`.
       * Each command must still match the `ALLOWED_COMMAND_PREFIXES` allowlist.
       */
      extraCommands: z
        .array(z.string())
        .optional()
        .describe("Additional commands to append, must match the allowed prefix list"),
    }),
    execute: async ({ riskLevel, extraCommands = [] }) => {
      // Dry-run: skip all command execution and report success.
      if (config.sync.dryRun) {
        return { dryRun: true, results: [], allPassed: true }
      }

      // Map each level to its configured command list from config.validation.
      type ValidationLevel = RiskLevel | "final"
      const suites: Record<ValidationLevel, string[]> = {
        low: config.validation.low,
        medium: config.validation.medium,
        high: config.validation.high,
        final: config.validation.final ?? [],
      }

      // Config-defined commands run via bash (supports pushd/popd, &&, etc.).
      const configCommands = suites[riskLevel]
      const configResults = runTrustedSuite(configCommands, config.workingDir)
      const configPassed = configResults.every((r) => r.success)

      // LLM-suggested extraCommands run only when the config suite passed,
      // and they remain subject to the prefix allowlist.
      const extraResults =
        configPassed && extraCommands.length > 0
          ? runValidationSuite(extraCommands, config.workingDir)
          : []

      const allResults = [...configResults, ...extraResults]
      const allPassed = allResults.every((r) => r.success)

      return { riskLevel, results: allResults, allPassed }
    },
    // 10-minute overall timeout: generous enough for full build suites (VSIX packaging, etc.).
    timeoutMs: 600_000,
  })
}
```

