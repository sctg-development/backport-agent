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
 * Builds the final CLI report for a no-op sync run.
 *
 * This path is used when the upstream branch has no pending commits compared to
 * the fork branch, so the agent runtime is skipped entirely.
 */
export function buildNoopSyncReport({
  upstreamRef,
  forkRef,
  dryRun,
}: {
  upstreamRef: string
  forkRef: string
  dryRun: boolean
}): string {
  const date = new Date().toISOString()

  return [
    "## Backport Agent — Sync Report",
    "",
    `**Date**: ${date}`,
    `**Upstream ref**: \`${upstreamRef}\``,
    `**Fork ref**: \`${forkRef}\``,
    `**Sync branch**: ${dryRun ? "_dry-run (no branch created)_" : "_none (already in sync)_"}`,
    "",
    "### Summary",
    "",
    "- ✅ Applied: 0",
    "- ⚠️ Needs human review: 0",
    "- ⛔ Blocked (not attempted): 0",
    "- ℹ️ No upstream commits were pending; the fork is already in sync.",
    "",
  ].join("\n")
}