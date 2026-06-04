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
 *  2. If it fails, deepen to the next target depth by fetching only the *delta*
 *     (`--deepen=<delta>`) so that each fetch step adds the minimum required
 *     commits.  Tracking the delta avoids cumulative overfetching that would
 *     occur when passing the absolute target depth directly to `--deepen`.
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
  // Progressive depth ladder: target depths to try in order.
  // We track the previously-fetched depth and pass only the *increment* to
  // --deepen so that each fetch adds exactly the commits needed rather than
  // refetching already-present history.
  const targetDepths = [200, 500, 1000, 2000, maxDepth]
  let currentDepth = 0

  for (const targetDepth of targetDepths) {
    try {
      // Attempt to find the common ancestor at the current history depth.
      return git(["merge-base", upstreamRef, forkRef], cwd)
    } catch {
      if (targetDepth === maxDepth) {
        // Last resort: fetch the entire history and try once more.
        git(["fetch", "--unshallow"], cwd)
        return git(["merge-base", upstreamRef, forkRef], cwd)
      }
      // Deepen by the delta to reach `targetDepth` without redundant refetching.
      const delta = targetDepth - currentDepth
      git(["fetch", `--deepen=${delta}`], cwd)
      currentDepth = targetDepth
    }
  }

  // Unreachable: the last iteration always returns or throws via --unshallow.
  throw new Error("Could not find merge-base even after full fetch")
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


