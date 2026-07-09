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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { parseCliArgs } from "./cli/args.js";
import { loadConfig } from "./config/loader.js";
import { applyGitAuth, ensureWorkingDir } from "./git/git-init.js";
import { ensureMergeBase, fetchRemotes, listCandidateCommits } from "./git/git-client.js";
import { buildNoopSyncReport } from "./reports/noop-report.js";
import { buildContextAbortReport } from "./reports/context-abort-report.js";
import { setupAgent } from "./agent/agent-setup.js";
import { setupEventHandlers } from "./agent/event-handlers.js";
import { runWithRetry } from "./agent/retry-logic.js";
import { CHECKPOINT_FILENAME } from "./git/git-tools.js";
import type { SyncConfig } from "./config/schema.js";

/**
 * Gets the sync branch name from the environment variable if available, otherwise generates
 * a fallback branch name using the same pattern as createSyncBranchTool.
 *
 * @param config - The sync configuration
 * @returns The sync branch name
 */
function getSyncBranchNameFromEnvironmentVariable(config: SyncConfig): string {
  return process.env.BACKPORT_AGENT_SYNC_BRANCH ?? `sync/${config.upstream.branch}-to-${config.fork.branch}`
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
    config.upstream.cutDate ? new Date(config.upstream.cutDate) : undefined,
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
        console.log(`${c.date.toISOString()}   ${c.sha}  ${c.subject}`)
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
  const { agentFactory, userInstructionService, runState, keypoolStats } = await setupAgent({
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

    // --- Exit-code mapping from the host-side run state ---
    // 0 = clean sync, 2 = sync completed but needs human attention.
    // A cron wrapper can use this to decide whether to notify the owner.
    const outcome = runState.reportOutcome
    const needsAttention =
      (outcome !== null &&
        (outcome.needsHumanReview || outcome.blockedCount > 0 || outcome.unaccountedCount > 0)) ||
      runState.validations.some((v) => !v.allPassed) ||
      runState.gateEvents.length > 0
    if (needsAttention) {
      process.exitCode = 2
      process.stderr.write(
        `[Outcome] Run needs human attention (exit code 2)` +
          (outcome
            ? `: needsHumanReview=${outcome.needsHumanReview}, blocked=${outcome.blockedCount}, unaccounted=${outcome.unaccountedCount}, gateEvents=${runState.gateEvents.length}\n`
            : `: validation failed or host gates fired before a report was generated\n`),
      )
    }

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
        const syncBranchName = getSyncBranchNameFromEnvironmentVariable(config)
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
        // A context-limit abort always needs human attention (some commits deferred).
        process.exitCode = 2
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
  // Preserve the exit code set from the run outcome (0 clean, 2 needs attention).
  .then(() => process.exit(process.exitCode ?? 0))
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
