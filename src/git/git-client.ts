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
 * progressively deepens the clone in steps rather than fetching the entire
 * history at once, which keeps network usage low for the common case.
 *
 * Algorithm:
 *  1. Try `git merge-base` at the current depth.
 *  2. If it fails, deepen by the next step value and retry.
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
  // Progressive depth ladder: try cheaper options first to minimise fetch size.
  const depths = [200, 500, 1000, 2000, maxDepth]

  for (const depth of depths) {
    try {
      // Attempt to find the common ancestor at the current history depth.
      return git(["merge-base", upstreamRef, forkRef], cwd)
    } catch {
      if (depth === maxDepth) {
        // Last resort: fetch the entire history and try once more.
        git(["fetch", "--unshallow"], cwd)
        return git(["merge-base", upstreamRef, forkRef], cwd)
      }
      // Deepen the shallow clone by the next step and loop.
      git(["fetch", `--deepen=${depth}`], cwd)
    }
  }

  throw new Error("Could not find merge-base even after full fetch")
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
 * @param cwd         - Absolute path to the repository working directory.
 * @param upstreamRef - Full ref for the upstream branch, e.g. `"upstream/main"`.
 * @param forkRef     - Full ref for the fork branch, e.g. `"origin/main"`.
 * @returns Array of `CandidateCommit` objects, oldest-first.
 */
export function listCandidateCommits(
  cwd: string,
  upstreamRef: string,
  forkRef: string,
): CandidateCommit[] {
  // `git cherry -v <upstream> <fork>` lists commits reachable from <upstream>
  // but not equivalent in <fork>.  The `-v` flag adds the subject line.
  const cherryOutput = git(["cherry", "-v", forkRef, upstreamRef], cwd)

  // Empty output means upstream and fork are already in sync.
  if (!cherryOutput) return []

  return cherryOutput.split("\n").map((line) => {
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
}

/**
 * Returns the list of file paths changed by a single commit.
 *
 * Internally calls `git diff-tree --no-commit-id -r --name-only <sha>` which
 * lists only changed paths without any diff content, keeping the output small.
 *
 * @param cwd - Absolute path to the repository working directory.
 * @param sha - Full or abbreviated commit SHA.
 * @returns Array of repository-relative file paths changed by the commit.
 *          Empty array if the commit has no file changes (e.g. an empty commit).
 */
export function getCommitChangedFiles(cwd: string, sha: string): string[] {
  const output = git(["diff-tree", "--no-commit-id", "-r", "--name-only", sha], cwd)
  // Filter out empty strings that result from splitting a trailing newline.
  return output ? output.split("\n").filter(Boolean) : []
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
export function getFileAtRef(cwd: string, ref: string, filePath: string): string | null {
  try {
    // `git show <ref>:<path>` streams the blob content to stdout.
    return git(["show", `${ref}:${filePath}`], cwd)
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


