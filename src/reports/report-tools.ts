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
 *
 * Report sections:
 *  1. Header — date, upstream ref, fork ref, sync branch name.
 *  2. Summary — counts of applied / needs-review / blocked commits.
 *  3. Applied commits — listed with risk badges and conflict-resolution notes.
 *  4. Human review required — conflicted or validation-failed commits with reasons.
 *  5. Blocked commits — SHAs that were not attempted at all.
 *  6. Agent decision log — ordered audit trail of key agent decisions.
 */

import { z } from "zod"
import { defineTool } from "../tool-helper.js"
import type { SyncConfig } from "../config/schema.js"

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

/**
 * Builds and returns the `generate_report` agent tool.
 *
 * The tool is pre-bound to `config` (though it currently uses no config fields
 * directly — it is included for API consistency and potential future use).
 *
 * @param config - Validated `SyncConfig` (reserved for future use).
 * @returns A single agent tool: `generate_report` (with `completesRun: true`).
 */
export function makeReportTool(config: SyncConfig) {
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
      /** SHAs of commits that were not attempted at all (e.g. blocked by policy). */
      blockedCommits: z.array(z.string()).describe("SHAs that were skipped entirely"),
      /** Ordered list of key decisions the agent made during this run, for audit purposes. */
      agentDecisions: z.array(z.string()).describe("Audit trail of key decisions made during this run"),
    }),
    // completesRun:true tells the SDK to stop the agent loop after this tool returns.
    lifecycle: { completesRun: true },
    execute: async ({ syncBranch, upstreamRef, forkRef, commitResults, blockedCommits, agentDecisions }) => {
      const date = new Date().toISOString()

      // --- Partition commits by final status for the summary section ---
      const applied = commitResults.filter((r) => ["applied", "conflict-resolved"].includes(r.status))
      const needsReview = commitResults.filter((r) => ["conflict-blocked", "validation-failed"].includes(r.status))
      const allPassed = needsReview.length === 0

      // --- Build the Markdown report line by line ---
      const lines: string[] = [
        "## Backport Agent — Sync Report",
        "",
        `**Date**: ${date}`,
        `**Upstream ref**: \`${upstreamRef}\``,
        `**Fork ref**: \`${forkRef}\``,
        // Show the branch name in backticks, or a dry-run notice.
        `**Sync branch**: ${syncBranch ? `\`${syncBranch}\`` : "_dry-run (no branch created)_"}`,
        "",
        "### Summary",
        "",
        `- ✅ Applied: ${applied.length}`,
        `- ⚠️ Needs human review: ${needsReview.length}`,
        `- ⛔ Blocked (not attempted): ${blockedCommits.length}`,
        "",
      ]

      // --- Section: successfully applied commits ---
      if (applied.length > 0) {
        lines.push("### Applied commits", "")
        for (const r of applied) {
          // Append a note when the agent resolved conflicts automatically.
          const badge = r.status === "conflict-resolved" ? " _(conflict resolved by agent)_" : ""
          lines.push(`- \`${r.sha.slice(0, 8)}\` [${r.riskLevel}] ${r.subject}${badge}`)
        }
        lines.push("")
      }

      // --- Section: commits requiring human review ---
      if (needsReview.length > 0) {
        lines.push("### ⚠️ Human review required", "")
        for (const r of needsReview) {
          lines.push(`- \`${r.sha.slice(0, 8)}\` ${r.subject}`)
          // List each conflicted file path as a sub-bullet.
          if (r.conflictedFiles?.length) {
            lines.push(`  - Conflicted files: ${r.conflictedFiles.join(", ")}`)
          }
          // List each human-review reason (may include customization invariants).
          if (r.humanReviewReasons?.length) {
            for (const reason of r.humanReviewReasons) {
              lines.push(`  - ${reason}`)
            }
          }
        }
        lines.push("")
      }

      // --- Section: blocked commits ---
      if (blockedCommits.length > 0) {
        lines.push("### Blocked commits (not attempted)", "")
        for (const sha of blockedCommits) {
          // Show only the first 8 characters of each SHA for readability.
          lines.push(`- \`${sha.slice(0, 8)}\``)
        }
        lines.push("")
      }

      // --- Section: agent decision audit log ---
      if (agentDecisions.length > 0) {
        lines.push("### Agent decision log", "")
        for (const decision of agentDecisions) {
          lines.push(`- ${decision}`)
        }
        lines.push("")
      }

      const report = lines.join("\n")

      // Build the machine-readable state object for idempotent re-runs.
      // This is embedded in the PR body as a hidden HTML comment (see github-tools.ts).
      const agentState = {
        generatedAt: date,
        appliedShas: applied.map((r) => r.sha),
        blockedShas: blockedCommits,
        needsReviewShas: needsReview.map((r) => r.sha),
      }

      return { report, agentState, allPassed, needsHumanReview: needsReview.length > 0 }
    },
  })
}
