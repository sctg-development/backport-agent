/**
 * @file main.ts
 *
 * Entry point for the Backport Agent CLI.
 *
 * **Initialization sequence:**
 *  1. Parse CLI arguments (`--verbose`, `--config`, `--backport-customizations`,
 *     `--keypool-vault-url`, `--keypool-live-secret`, `--keypool-state-file`, `--dry-run`).
 *  2. Validate required environment variables (`KEYPOOL_VAULT_URL` or `KEYPOOL_LIVE_SECRET`).
 *  3. Load and validate `config.json` via `loadConfig()`.
 *  4. Load and validate `customizations.yaml` via `loadCustomizations()`.
 *  5. Assemble all agent tools from the individual factory functions.
 *  6. Instantiate the `Agent` with the keypoollive provider, system prompt, and tools.
 *  7. Subscribe to runtime events to stream assistant output to stdout.
 *  8. Call `agent.run(task)` with the sync task description.
 *  9. Print the final report (or exit with code 1 on any fatal error).
 *
 * **Provider:**
 * `keypoollive` with `apiKey: "auto"` uses the `KEYPOOL_VAULT_URL` environment
 * variable to resolve API keys at runtime via an encrypted vault, enabling
 * automatic key rotation without storing secrets in the codebase.
 */
/// <reference types="node" />
// ---------------------------------------------------------------------------
// CLI argument parsing — runs before .env loading so flags can override env.
// ---------------------------------------------------------------------------
{
  const argv = process.argv.slice(2)
  function getArgValue(name: string): string | undefined {
    const idx = argv.indexOf(name)
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined
  }
  function hasFlag(name: string): boolean {
    return argv.includes(name)
  }

  if (hasFlag("--verbose")) process.env.VERBOSE = "true"
  if (hasFlag("--dry-run")) process.env.DRY_RUN = "true"
  const cliConfig = getArgValue("--config")
  if (cliConfig) process.env._CLI_CONFIG_PATH = cliConfig
  const cliCustomizations = getArgValue("--backport-customizations")
  if (cliCustomizations) process.env.BACKPORT_CUSTOMIZATIONS = cliCustomizations
  const cliVaultUrl = getArgValue("--keypool-vault-url")
  if (cliVaultUrl) process.env.KEYPOOL_VAULT_URL = cliVaultUrl
  const cliLiveSecret = getArgValue("--keypool-live-secret")
  if (cliLiveSecret) process.env.KEYPOOL_LIVE_SECRET = cliLiveSecret
  const cliStateFile = getArgValue("--keypool-state-file")
  if (cliStateFile) process.env.KEYPOOL_STATE_FILE = cliStateFile
}
// Load .env file if present — allows setting KEYPOOL_VAULT_URL, KEYPOOL_LIVE_SECRET,
// BACKPORT_CUSTOMIZATIONS, etc. without modifying the shell environment.
// Uses Node.js 20.6+ built-in --env-file support via the `dotenv` fallback.
import { existsSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
{
  const envPath = resolvePath(process.cwd(), ".env")
  if (existsSync(envPath)) {
    const { config } = await import("dotenv")
    config({ path: envPath })
  }
}
import { Agent, createBuiltinTools, createUserInstructionConfigService } from "@sctg/cline-sdk"
import type { UserInstructionConfigRecord } from "@sctg/cline-sdk"
import { loadConfig } from "./config/loader.js"
import { loadCustomizations } from "./customizations/loader.js"
import { makeGitTools } from "./git/git-tools.js"
import { applyGitAuth, ensureWorkingDir } from "./git/git-init.js"
import { makeRiskTool } from "./risk/risk-tools.js"
import { makeValidationTool } from "./validation/validation-tools.js"
import { makeGitHubTools } from "./github/github-tools.js"
import { makeReportTool } from "./reports/report-tools.js"
import { makeAiTools } from "./ai/ai-tools.js"

// ---------------------------------------------------------------------------
// System prompt — defines the agent's responsibilities and constraints.
// This is a multi-line template string embedded directly in main.ts so that
// the full agent workflow is visible in a single place for auditability.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are the Backport Agent, a specialist in safely synchronizing a customized Git fork with its upstream repository.

## Your mission
Integrate upstream commits into the fork branch while preserving all fork-specific customizations.
Produce a draft pull request with a clear report. Never push directly to the main branch.

## Core workflow (follow this exactly)

1. Call fetch_remotes to ensure refs are up to date.
2. Call list_candidate_commits to get pending upstream commits (already filtered, newest-last).
   - Record all returned SHAs immediately. You are accountable for every single one.
3. For each candidate commit (process ALL of them — no silent skips):
   a. Call get_commit_details to inspect changed files and diff.
   b. Call classify_commit_risk to determine risk level deterministically.
   c. Risk-based decision:
      - LOW risk: proceed directly to step 5 (cherry-pick). No AI analysis needed.
      - MEDIUM risk: call analyze_commit_for_backport for context, then proceed to cherry-pick.
      - HIGH risk (touches a customization zone):
        * MANDATORY: Call check_customization_compatibility — pass the diff and all affected customization IDs.
        * MANDATORY: Call analyze_commit_for_backport — pass sha, message, diff, and changed files.
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
      - (When forcedStrategy is null) Call resolve_conflict_with_ai with the base/ours/theirs content to get an AI-proposed resolution.
      - If confidence is "high" or "medium": verify no conflict markers remain, then call apply_resolved_file, then continue_cherry_pick.
      - If confidence is "low" or the tool returned an error: call abort_cherry_pick, mark commit as conflict-blocked.
6. Call run_validation with the highest risk level encountered in this run.
7. If validation fails: note it in the report, mark relevant commits as validation-failed.
8. Call push_sync_branch (unless dry-run).
9. Call find_existing_sync_pr to check for an existing PR.
10. Call generate_report with the full summary of all decisions.
11. Call create_sync_pr with the report as body (unless an existing PR was found and up to date).

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
- If KEYPOOL_VAULT_URL is not set and apiKey is "auto", the run will fail before reaching this point.
`

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
  // --- Environment validation ---
  // Fail fast if the provider cannot authenticate: avoids a confusing runtime
  // error deep inside the agent run.
  if (!process.env.KEYPOOL_VAULT_URL && !process.env.KEYPOOL_LIVE_SECRET) {
    console.error(
      "Error: KEYPOOL_VAULT_URL environment variable is required for the keypoollive provider.\n" +
        "Set it to your encrypted vault URL (e.g. https://raw.githubusercontent.com/.../ai.json.XXXX.enc)\n" +
        "along with KEYPOOL_LIVE_SECRET as the decryption key.",
    )
    process.exit(1)
  }

  // --- Config & customization loading ---
  // Both loaders throw descriptive errors if the files are missing or invalid.
  const config = loadConfig(process.env._CLI_CONFIG_PATH)
  // loadCustomizations supports: string path, URL, or inline object from config.
  const customizations = await loadCustomizations(
    config.customizations ?? process.env.BACKPORT_CUSTOMIZATIONS,
  )

  // --- Authentication + working directory setup ---
  // applyGitAuth sets process-level env vars (GIT_SSH_COMMAND or GIT_CONFIG_*)
  // before any git call is made, so all subsequent operations use the right creds.
  // ensureWorkingDir clones the fork repo if it doesn't exist, or fetches all
  // remotes if it does, bringing the checkout up to date before the agent starts.
  applyGitAuth(config)
  ensureWorkingDir(config)

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
  // Prompt log file for this run — every sub-agent LLM call is appended here.
  const promptLogPath = resolvePath(`run-${Date.now()}.prompts.jsonl`)
  process.stderr.write(`[PromptLogger] Writing sub-agent logs to: ${promptLogPath}\n`)

  const reportTool = makeReportTool(config, promptLogPath) // 1 terminal tool (completesRun: true)
  const aiTools = makeAiTools(config, promptLogPath)       // 3 AI-powered analysis tools

  // --- SDK built-in tools ---
  // Add Cline integrated tools so the agent can also perform generic workspace
  // operations through the standard runtime surface.
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
      submit: async (summary: string, verified: boolean) =>
        `submit_and_exit acknowledged (verified=${verified ? "true" : "false"}): ${summary}`,
    },
  })

  // Flatten all tools into a single array for the Agent constructor.
  const allTools = [...builtinTools, ...gitTools, riskTool, validationTool, ...githubTools, reportTool, ...aiTools]

  // --- Agent instantiation ---
  // Using the keypoollive provider with "auto" apiKey — the SDK resolves the
  // actual API key at runtime via KEYPOOL_VAULT_URL.
  // config.models.fast selects the model configured for speed (see config.json).
  const agent = new Agent({
    providerId: "keypoollive",
    modelId: config.models.fast,
    apiKey: "auto", // SDK resolves via KEYPOOL_VAULT_URL at invocation time
    systemPrompt: SYSTEM_PROMPT,
    tools: allTools,
    maxIterations: config.sync.maxIterations,
    // Prevent the run from ending until generate_report (completesRun: true) is called.
    completionPolicy: { requireCompletionTool: true },
  })

  // --- Event subscription ---
  // Stream assistant text deltas to stdout so the operator can watch progress.
  // Tool-level progress (iterations, tool calls) is gated behind VERBOSE=true to
  // keep non-verbose runs clean.  Set VERBOSE=true in .env or the shell to enable.
  const verbose = process.env.VERBOSE === "true"
  let lastEventWasText = false
  // Track the highest iteration seen so far across all attempts, so that when
  // the agent is restarted after a provider error the displayed counter is
  // continuous rather than resetting to 1.
  let iterationOffset = 0
  let lastSeenIteration = 0
  let currentAttempt = 1
  agent.subscribe((event: Parameters<Parameters<typeof agent.subscribe>[0]>[0]) => {
    const rawIter = (event as unknown as { iteration?: number }).iteration
    if (typeof rawIter === "number" && rawIter > lastSeenIteration) {
      lastSeenIteration = rawIter
    }
    const displayIter = typeof rawIter === "number" ? iterationOffset + rawIter : "?"
    if (event.type === "assistant-text-delta") {
      lastEventWasText = true
      process.stdout.write(event.text)
    } else if (event.type === "tool-started" && verbose) {
      // Ensure tool log starts on a fresh line after any streamed text.
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

  // --- Task construction ---
  const dryRunNote = config.sync.dryRun ? " [DRY RUN — no changes will be pushed]" : ""
  const task =
    `Synchronize the fork \`${config.fork.repo}@${config.fork.branch}\` with upstream ` +
    `\`${config.upstream.repo}@${config.upstream.branch}\`.${dryRunNote}\n\n` +
    `Working directory: ${config.workingDir}\n` +
    `Max commits per run: ${config.sync.maxCommitsPerRun}\n` +
    `Batch size: ${config.sync.batchSize}`

  console.error(`\n=== Backport Agent starting${dryRunNote} ===\n`)

  // --- Provider retry helper ---
  // The SDK has no built-in retry for HTTP errors from the model provider.
  // Gemini (and other providers) occasionally return 503 / rate-limit responses;
  // this wrapper catches those and retries with exponential backoff.
  // Because agent state is persisted on disk (git), restarting the run is safe —
  // the agent will detect already-applied commits from the git log.
  const RETRIABLE_RE = /503|rate.?limit|too many requests|overloaded|service.?unavailable|high.?demand|try again later|temporarily unavailable|exceeded your current quota|quota.*exceeded|check your plan|billing details/i
  const BASE_DELAY_MS = 15_000
  const MAX_ATTEMPTS = 5

  async function runWithRetry(): Promise<Awaited<ReturnType<typeof agent.run>>> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      currentAttempt = attempt
      let result: Awaited<ReturnType<typeof agent.run>>
      try {
        result = await agent.run(task)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt < MAX_ATTEMPTS && RETRIABLE_RE.test(msg)) {
          const delay = BASE_DELAY_MS * attempt
          process.stderr.write(
            `[Retry] Provider error on attempt ${attempt}/${MAX_ATTEMPTS}: ${msg.slice(0, 120)}\n` +
              `[Retry] Waiting ${delay / 1000}s before retrying...\n`,
          )
          iterationOffset += lastSeenIteration
          lastSeenIteration = 0
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
        if (attempt < MAX_ATTEMPTS && RETRIABLE_RE.test(msg)) {
          const delay = BASE_DELAY_MS * attempt
          process.stderr.write(
            `[Retry] Silent provider error (status=${result.status}) on attempt ${attempt}/${MAX_ATTEMPTS}: ${msg.slice(0, 120)}\n` +
              `[Retry] Waiting ${delay / 1000}s before retrying...\n`,
          )
          iterationOffset += lastSeenIteration
          lastSeenIteration = 0
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw err
      }

      return result
    }
    throw new Error("unreachable")
  }

  // --- Run the agent ---
  // The agent loop runs until the `generate_report` tool is called
  // (`lifecycle: { completesRun: true }`) or an unrecoverable error occurs.
  try {
    const result = await runWithRetry()

    console.error(`\n=== Run complete ===\n`)
    if (result.outputText) {
      // The generate_report tool completes the run; outputText is the Markdown summary.
      console.log(result.outputText)
    } else {
      // With requireCompletionTool: true this should never happen on a clean run.
      throw new Error("Agent run completed but generate_report was never called (empty output). Check the prompt log for details.")
    }
  } finally {
    userInstructionService.stop()
  }
}

// Wrap main() in a .catch() handler to ensure the process exits with code 1
// on any unhandled error, rather than crashing with an unhandled rejection.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal error:", err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
