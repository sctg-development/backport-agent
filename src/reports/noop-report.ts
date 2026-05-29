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