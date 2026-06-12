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
