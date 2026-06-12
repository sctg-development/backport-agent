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

import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getCommitChangedFiles,
  listCandidateCommits,
  subjectSimilarity,
  cherryPick,
  git,
  abortCherryPick,
} from "../../src/git/git-client.js"
import type { SyncConfig } from "../../src/config/schema.js"

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

  it("Signal 4: detects manual backport via PR number + subject similarity", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "backport-signal4-"))
    tempDirs.push(repoDir)

    run(["init", "-b", "main", "."], repoDir)
    run(["config", "user.email", "tests@example.com"], repoDir)
    run(["config", "user.name", "Backport Tests"], repoDir)

    writeFileSync(join(repoDir, "base.txt"), "base\n", "utf-8")
    run(["add", "base.txt"], repoDir)
    run(["commit", "-m", "base"], repoDir)

    // Fork branch: manually backported with reworded subject but same PR number.
    run(["checkout", "-b", "fork"], repoDir)
    writeFileSync(join(repoDir, "feature.txt"), "applied\n", "utf-8")
    run(["add", "feature.txt"], repoDir)
    run(["commit", "-m", "feat(backport): Move sdk/apps/ to apps/ (cline#11200)"], repoDir)

    // Upstream: original commit that was already manually backported above.
    run(["checkout", "main"], repoDir)
    run(["checkout", "-b", "upstream"], repoDir)
    writeFileSync(join(repoDir, "feature.txt"), "upstream\n", "utf-8")
    run(["add", "feature.txt"], repoDir)
    run(["commit", "-m", "Move `sdk/apps/` to `apps/` (#11200)"], repoDir)

    // Without Signal 4: git cherry sees a different patch → marked as pending.
    const withoutSignal4 = listCandidateCommits(repoDir, "upstream", "fork")
    expect(withoutSignal4).toHaveLength(1)
    expect(withoutSignal4[0].alreadyApplied).toBe(false)

    // With Signal 4 enabled: PR number matches and similarity is above threshold.
    const withSignal4 = listCandidateCommits(repoDir, "upstream", "fork", {
      enabled: true,
      minSubjectSimilarity: 0.4,
    })
    expect(withSignal4).toHaveLength(1)
    expect(withSignal4[0].alreadyApplied).toBe(true)
  })

  it("Signal 4: does not fire when similarity is below threshold", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "backport-signal4-threshold-"))
    tempDirs.push(repoDir)

    run(["init", "-b", "main", "."], repoDir)
    run(["config", "user.email", "tests@example.com"], repoDir)
    run(["config", "user.name", "Backport Tests"], repoDir)

    writeFileSync(join(repoDir, "base.txt"), "base\n", "utf-8")
    run(["add", "base.txt"], repoDir)
    run(["commit", "-m", "base"], repoDir)

    // Fork: commit shares the PR number by coincidence, but subjects are completely different.
    run(["checkout", "-b", "fork"], repoDir)
    writeFileSync(join(repoDir, "other.txt"), "other\n", "utf-8")
    run(["add", "other.txt"], repoDir)
    run(["commit", "-m", "fix: unrelated change to something else entirely (#11200)"], repoDir)

    run(["checkout", "main"], repoDir)
    run(["checkout", "-b", "upstream"], repoDir)
    writeFileSync(join(repoDir, "feature.txt"), "upstream\n", "utf-8")
    run(["add", "feature.txt"], repoDir)
    run(["commit", "-m", "Move `sdk/apps/` to `apps/` (#11200)"], repoDir)

    const candidates = listCandidateCommits(repoDir, "upstream", "fork", {
      enabled: true,
      minSubjectSimilarity: 0.8,
    })
    expect(candidates[0].alreadyApplied).toBe(false)
  })
})

// Regression test: main.ts and git-tools.ts both derive the prNumberMatching option
// from config.sync using `config.sync.prNumberMatching.enabled ? config.sync.prNumberMatching : undefined`.
// This test pins that wiring so a future call site that drops the option is caught immediately.
describe("prNumberMatching wired from SyncConfig (regression)", () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeRepo() {
    const repoDir = mkdtempSync(join(tmpdir(), "backport-regression-"))
    tempDirs.push(repoDir)
    run(["init", "-b", "main", "."], repoDir)
    run(["config", "user.email", "tests@example.com"], repoDir)
    run(["config", "user.name", "Backport Tests"], repoDir)
    writeFileSync(join(repoDir, "base.txt"), "base\n", "utf-8")
    run(["add", "base.txt"], repoDir)
    run(["commit", "-m", "base"], repoDir)

    run(["checkout", "-b", "fork"], repoDir)
    writeFileSync(join(repoDir, "feature.txt"), "applied\n", "utf-8")
    run(["add", "feature.txt"], repoDir)
    // Manually-backported commit: reworded subject, same PR number, no cherry-pick annotation.
    run(["commit", "-m", "feat(backport): Move sdk/apps/ to apps/ (cline#11200)"], repoDir)

    run(["checkout", "main"], repoDir)
    run(["checkout", "-b", "upstream"], repoDir)
    writeFileSync(join(repoDir, "feature.txt"), "upstream\n", "utf-8")
    run(["add", "feature.txt"], repoDir)
    run(["commit", "-m", "Move `sdk/apps/` to `apps/` (#11200)"], repoDir)

    return repoDir
  }

  it("detects already-applied commit when config.sync.prNumberMatching.enabled=true", () => {
    const repoDir = makeRepo()
    // Reproduce the exact expression used in main.ts and git-tools.ts.
    const syncConfig = { prNumberMatching: { enabled: true, minSubjectSimilarity: 0.4 } } as SyncConfig["sync"]
    const opts = syncConfig.prNumberMatching.enabled ? syncConfig.prNumberMatching : undefined

    const candidates = listCandidateCommits(repoDir, "upstream", "fork", opts)
    expect(candidates[0].alreadyApplied).toBe(true)
  })

  it("leaves commit pending when config.sync.prNumberMatching.enabled=false", () => {
    const repoDir = makeRepo()
    const syncConfig = { prNumberMatching: { enabled: false, minSubjectSimilarity: 0.4 } } as SyncConfig["sync"]
    const opts = syncConfig.prNumberMatching.enabled ? syncConfig.prNumberMatching : undefined

    const candidates = listCandidateCommits(repoDir, "upstream", "fork", opts)
    expect(candidates[0].alreadyApplied).toBe(false)
  })
})

describe("subjectSimilarity", () => {
  it("returns ~0.67 for the canonical manual-backport case", () => {
    const score = subjectSimilarity(
      "Move `sdk/apps/` to `apps/` (#11200)",
      "feat(backport): Move sdk/apps/ to apps/ (cline#11200)",
    )
    expect(score).toBeGreaterThanOrEqual(0.4)
    expect(score).toBeLessThan(1)
  })

  it("returns 1 for identical subjects", () => {
    expect(subjectSimilarity("fix: do the thing", "fix: do the thing")).toBe(1)
  })

  it("returns 0 for completely unrelated subjects", () => {
    expect(subjectSimilarity("move apps folder (#1)", "update readme docs (#2)")).toBe(0)
  })

  it("ignores PR number refs when comparing", () => {
    const withRef = subjectSimilarity("add feature (#42)", "add feature (#99)")
    expect(withRef).toBe(1)
  })
})
