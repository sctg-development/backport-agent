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
      const forkVersion = getFileAtRef(workingDir, "HEAD", filePath)
      // Fetch the incoming upstream version (may be null for deleted files).
      const upstreamVersion = getFileAtRef(workingDir, "CHERRY_PICK_HEAD", filePath)
      // Read the working-tree file which contains conflict markers.
      let withMarkers: string | null = null
      try {
        withMarkers = readFileSync(`${workingDir}/${filePath}`, "utf-8")
      } catch {
        // The file may have been deleted by the upstream commit.
        withMarkers = null
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

      return { filePath, forkVersion, upstreamVersion, withMarkers, forcedStrategy }
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
