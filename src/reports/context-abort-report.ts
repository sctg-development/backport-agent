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

import type { CandidateCommit } from "../git/git-client.js"

/**
 * Builds a partial sync report when the agent run was aborted due to the context
 * window hard limit being reached before `generate_report` could be called.
 *
 * The checkpoint file preserves any SHAs that were successfully cherry-picked so
 * the next run can resume from where this one stopped.
 */
export function buildContextAbortReport({
  upstreamRef,
  forkRef,
  appliedShas,
  syncBranch,
  pendingCommits,
  dryRun,
}: {
  upstreamRef: string
  forkRef: string
  appliedShas: string[]
  syncBranch: string
  pendingCommits: CandidateCommit[]
  dryRun: boolean
}): string {
  const date = new Date().toISOString()
  const dryRunNote = dryRun ? " [DRY RUN]" : ""

  const appliedSet = new Set(appliedShas.map((s) => s.slice(0, 8)))
  const blocked = pendingCommits.filter((c) => !appliedSet.has(c.sha.slice(0, 8)))

  const lines: string[] = [
    "## Backport Agent — Sync Report (context-limit abort)",
    "",
    `**Date**: ${date}`,
    `**Upstream ref**: \`${upstreamRef}\``,
    `**Fork ref**: \`${forkRef}\``,
    `**Sync branch**: \`${syncBranch}\`${dryRunNote}`,
    "",
    "### Summary",
    "",
    `- ✅ Applied: ${appliedShas.length}`,
    "- ⚠️ Needs human review: 0",
    `- ⛔ Blocked (not attempted): ${blocked.length}`,
    "",
    "> ⚠️ **Run aborted — context window hard limit reached before `generate_report` was called.**",
    "> The checkpoint file has been preserved. The next run will resume from the first unprocessed commit.",
    "",
  ]

  if (appliedShas.length > 0) {
    lines.push("### ✅ Applied commits (from checkpoint)")
    lines.push("")
    for (const sha of appliedShas) {
      const match = pendingCommits.find((c) => c.sha.startsWith(sha.slice(0, 8)))
      const subject = match?.subject ?? "(subject unknown)"
      lines.push(`- \`${sha.slice(0, 8)}\` ${subject}`)
    }
    lines.push("")
  }

  if (blocked.length > 0) {
    lines.push("### ⛔ Blocked commits (deferred to next run)")
    lines.push("")
    for (const c of blocked) {
      lines.push(`- \`${c.sha.slice(0, 8)}\` — context-limit: deferred to next run`)
      lines.push(`  - ${c.subject}`)
    }
    lines.push("")
  }

  return lines.join("\n")
}
