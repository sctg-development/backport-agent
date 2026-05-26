/**
 * @file risk/risk-tools.ts
 *
 * Factory that creates the `classify_commit_risk` agent tool.
 *
 * Risk classification is a deterministic gate that runs **before** any LLM
 * reasoning: the agent calls this tool first, learns the risk level and
 * affected customizations, then decides how to proceed (auto-apply, apply with
 * validation, or escalate to human review).
 *
 * The tool is kept in a separate factory function so that the validated
 * `customizations` object (loaded once at startup) can be captured by closure
 * and reused across every invocation without re-parsing the YAML file.
 */

import { z } from "zod"
import { defineTool } from "../tool-helper.js"
import { classifyRisk } from "./classify-risk.js"
import { getCommitChangedFiles } from "../git/git-client.js"
import type { SyncConfig } from "../config/schema.js"
import type { Customizations } from "../customizations/schema.js"

/**
 * Builds and returns the `classify_commit_risk` agent tool.
 *
 * The tool is pre-bound to `config` and `customizations` so that callers only
 * need to provide the commit SHA at invocation time.
 *
 * @param config          - Validated `SyncConfig` (provides `workingDir`).
 * @param customizations  - Validated customizations manifest (provides zone definitions).
 * @returns A single agent tool: `classify_commit_risk`.
 */
export function makeRiskTool(config: SyncConfig, customizations: Customizations) {
  return defineTool({
    name: "classify_commit_risk",
    description:
      "Classify the risk level of an upstream commit by analysing which files it changes. " +
      "Returns 'low', 'medium', or 'high' with human-readable reasons. " +
      "High risk means the commit touches fork customization zones or build-critical files. " +
      "This is a deterministic check — no LLM is used here.",
    inputSchema: z.object({
      /** Full or abbreviated SHA of the upstream commit to classify. */
      sha: z.string().describe("Upstream commit SHA to classify"),
    }),
    execute: async ({ sha }) => {
      // 1. Retrieve the list of paths changed by this commit from git.
      const changedFiles = getCommitChangedFiles(config.workingDir, sha)
      // 2. Run the deterministic pattern matcher against those paths.
      const risk = classifyRisk(sha, changedFiles, customizations)
      // The full CommitRisk object is returned to the agent as tool output.
      return risk
    },
  })
}
