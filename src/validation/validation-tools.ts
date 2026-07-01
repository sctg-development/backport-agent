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
 * @file validation/validation-tools.ts
 *
 * Factory that creates the `run_validation` agent tool.
 *
 * Validation is the agent's safety net: before accepting a cherry-picked commit
 * as "done", the agent runs the suite appropriate for the commit's risk level to
 * confirm that the fork still builds and passes tests.
 *
 * Risk → suite mapping (configured in `config.validation`):
 *  - `"low"`    → `config.validation.low`    (e.g. only typecheck)
 *  - `"medium"` → `config.validation.medium` (e.g. typecheck + unit tests)
 *  - `"high"`   → `config.validation.high`   (e.g. full build + integration tests)
 *
 * The agent may append extra customization-specific commands via the
 * `extraCommands` input field.  All commands (base suite + extras) are passed
 * through the same `ALLOWED_COMMAND_PREFIXES` allowlist in `commands.ts`.
 */

import { z } from "zod"
import { defineTool } from "../tool-helper.js"
import { runTrustedSuite, runValidationSuite } from "./commands.js"
import type { SyncConfig } from "../config/schema.js"
import type { RiskLevel } from "../risk/classify-risk.js"

/**
 * Builds and returns the `run_validation` agent tool.
 *
 * The tool is pre-bound to `config` so that the caller only needs to supply the
 * risk level and any optional extra commands at invocation time.
 *
 * @param config - Validated `SyncConfig` (provides `workingDir` and `validation` suites).
 * @returns A single agent tool: `run_validation`.
 */
export function makeValidationTool(config: SyncConfig) {
  return defineTool({
    name: "run_validation",
    description:
      "Run the validation suite appropriate for a given risk level. " +
      "'low' runs only typecheck. 'medium' adds unit tests. 'high' adds build and integration tests. " +
      "'final' runs the comprehensive end-to-end build suite from config.validation.final (call this once after all commits are processed). " +
      "Config-defined commands run via bash; LLM-supplied extraCommands are subject to the prefix allowlist. " +
      "Returns success status and per-command output.",
    inputSchema: z.object({
      /** Risk level computed by `classify_commit_risk`, or "final" for the end-to-end build suite. */
      riskLevel: z.enum(["low", "medium", "high", "final"]).describe("Risk level determines which suite to run; use 'final' for the comprehensive end-to-end build check"),
      /**
       * Optional additional commands to append to the standard suite.
       * Useful for customization-specific verification commands listed in
       * `customizations.yaml` under `testCommands`.
       * Each command must still match the `ALLOWED_COMMAND_PREFIXES` allowlist.
       */
      extraCommands: z
        .array(z.string())
        .optional()
        .describe("Additional commands to append, must match the allowed prefix list"),
    }),
    execute: async ({ riskLevel, extraCommands = [] }) => {
      // Dry-run: skip all command execution and report success.
      if (config.sync.dryRun) {
        process.stderr.write(`[Validation] Skipped (dry-run mode): ${riskLevel} suite\n`)
        return { dryRun: true, results: [], allPassed: true }
      }

      // Map each level to its configured command list from config.validation.
      type ValidationLevel = RiskLevel | "final"
      const suites: Record<ValidationLevel, string[]> = {
        low: config.validation.low,
        medium: config.validation.medium,
        high: config.validation.high,
        final: config.validation.final ?? [],
      }

      const configCommands = suites[riskLevel]
      const totalExtra = extraCommands.length

      process.stderr.write(
        `\n[Validation] ═══ Starting "${riskLevel}" suite` +
        ` (${configCommands.length} command(s)${totalExtra > 0 ? ` + ${totalExtra} extra` : ""}) ═══\n`,
      )

      // Config-defined commands run via bash (supports pushd/popd, &&, etc.).
      const configResults = runTrustedSuite(configCommands, config.workingDir)
      const configPassed = configResults.every((r) => r.success)

      // LLM-suggested extraCommands run only when the config suite passed,
      // and they remain subject to the prefix allowlist.
      const extraResults =
        configPassed && totalExtra > 0
          ? runValidationSuite(extraCommands, config.workingDir)
          : []

      const allResults = [...configResults, ...extraResults]
      const allPassed = allResults.every((r) => r.success)

      process.stderr.write(
        `[Validation] ═══ "${riskLevel}" suite ${allPassed ? "PASSED ✓" : "FAILED ✗"} ═══\n\n`,
      )

      return { riskLevel, results: allResults, allPassed }
    },
    // 10-minute overall timeout: generous enough for full build suites (VSIX packaging, etc.).
    timeoutMs: 600_000,
  })
}
