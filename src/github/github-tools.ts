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
