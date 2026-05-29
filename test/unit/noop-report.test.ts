import { describe, expect, it } from "vitest"
import { buildNoopSyncReport } from "../../src/reports/noop-report.js"

describe("buildNoopSyncReport", () => {
  it("renders a no-op report when the fork is already in sync", () => {
    const report = buildNoopSyncReport({
      upstreamRef: "upstream/main",
      forkRef: "origin/main",
      dryRun: false,
    })

    expect(report).toContain("## Backport Agent — Sync Report")
    expect(report).toContain("**Upstream ref**: `upstream/main`")
    expect(report).toContain("**Fork ref**: `origin/main`")
    expect(report).toContain("**Sync branch**: _none (already in sync)_")
    expect(report).toContain("- ℹ️ No upstream commits were pending; the fork is already in sync.")
    expect(report).toMatch(/\*\*Date\*\*: \d{4}-\d{2}-\d{2}T/)
  })

  it("marks dry-run mode explicitly", () => {
    const report = buildNoopSyncReport({
      upstreamRef: "upstream/release",
      forkRef: "origin/release",
      dryRun: true,
    })

    expect(report).toContain("**Sync branch**: _dry-run (no branch created)_")
  })
})