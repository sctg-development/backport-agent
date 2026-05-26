import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getCommitChangedFiles,
  listCandidateCommits,
  cherryPick,
  git,
  abortCherryPick,
} from "../../src/git/git-client.js"

function run(cmd: string[], cwd: string): string {
  return execFileSync("git", cmd, { cwd, encoding: "utf-8" }).trim()
}

describe("git-client integration", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("lists upstream candidates not yet applied to fork", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "backport-git-client-"))
    tempDirs.push(repoDir)

    run(["init", "-b", "main", "."], repoDir)
    run(["config", "user.email", "tests@example.com"], repoDir)
    run(["config", "user.name", "Backport Tests"], repoDir)

    writeFileSync(join(repoDir, "shared.txt"), "base\n", "utf-8")
    run(["add", "shared.txt"], repoDir)
    run(["commit", "-m", "base"], repoDir)

    run(["checkout", "-b", "fork"], repoDir)
    writeFileSync(join(repoDir, "fork-only.txt"), "fork\n", "utf-8")
    run(["add", "fork-only.txt"], repoDir)
    run(["commit", "-m", "fork commit"], repoDir)

    run(["checkout", "main"], repoDir)
    run(["checkout", "-b", "upstream"], repoDir)
    writeFileSync(join(repoDir, "upstream-only.txt"), "upstream\n", "utf-8")
    run(["add", "upstream-only.txt"], repoDir)
    run(["commit", "-m", "upstream commit"], repoDir)

    const candidates = listCandidateCommits(repoDir, "upstream", "fork")

    expect(candidates).toHaveLength(1)
    expect(candidates[0].alreadyApplied).toBe(false)
    expect(candidates[0].subject).toContain("upstream commit")

    const changedFiles = getCommitChangedFiles(repoDir, candidates[0].sha)
    expect(changedFiles).toContain("upstream-only.txt")
  })

  it("detects conflicts during cherry-pick", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "backport-git-conflict-"))
    tempDirs.push(repoDir)

    run(["init", "-b", "main", "."], repoDir)
    run(["config", "user.email", "tests@example.com"], repoDir)
    run(["config", "user.name", "Backport Tests"], repoDir)

    writeFileSync(join(repoDir, "same.txt"), "base\n", "utf-8")
    run(["add", "same.txt"], repoDir)
    run(["commit", "-m", "base"], repoDir)

    run(["checkout", "-b", "fork"], repoDir)
    writeFileSync(join(repoDir, "same.txt"), "fork\n", "utf-8")
    run(["add", "same.txt"], repoDir)
    run(["commit", "-m", "fork edits same line"], repoDir)

    run(["checkout", "main"], repoDir)
    run(["checkout", "-b", "upstream"], repoDir)
    writeFileSync(join(repoDir, "same.txt"), "upstream\n", "utf-8")
    run(["add", "same.txt"], repoDir)
    run(["commit", "-m", "upstream edits same line"], repoDir)

    run(["checkout", "fork"], repoDir)
    const upstreamSha = git(["rev-parse", "upstream"], repoDir)

    const result = cherryPick(repoDir, upstreamSha)

    expect(result.success).toBe(false)
    expect(result.conflictedFiles).toContain("same.txt")

    abortCherryPick(repoDir)
  })
})
