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