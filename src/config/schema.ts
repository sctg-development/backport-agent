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
