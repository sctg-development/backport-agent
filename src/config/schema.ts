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
      /** Maximum number of upstream commits to process in a single agent run. Defaults to 20. */
      maxCommitsPerRun: z.number().int().positive().default(20),
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
    })
    // Allow omitting the entire sync block in config.json; each field has its own default.
    .default(() => ({} as any)),

  /**
   * LLM model identifiers for the keypoollive provider.
   * Use a cheap/fast model for high-volume triage and a more powerful one for
   * conflict resolution where reasoning quality matters most.
   */
  models: z
    .object({
      /**
       * Model used for fast, inexpensive tasks such as summarising diffs and
       * classifying risk alongside the deterministic rule engine.
       * Defaults to `"mistral/devstral-latest"`.
       */
      fast: z.string().default("mistral/devstral-latest").describe("Low-cost model for summaries and risk triage"),
      /**
       * Model used for complex conflict resolution that demands deeper reasoning.
       * Defaults to `"mistral/magistral-medium-latest"`.
       */
      powerful: z
        .string()
        .default("mistral/magistral-medium-latest")
        .describe("High-capability model for conflict resolution"),
    })
    // Allow omitting the entire models block; individual fields carry defaults.
    .default(() => ({} as any)),

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
    })
    // Allow omitting the entire validation block; individual fields carry defaults.
    .default(() => ({} as any)),
})

/**
 * TypeScript type derived directly from `SyncConfigSchema`.
 * Use this type throughout the codebase instead of repeating the inline shape.
 */
export type SyncConfig = z.infer<typeof SyncConfigSchema>
