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
import { runValidationSuite } from "./commands.js"
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
      "All commands are allowlisted — arbitrary commands are rejected. " +
      "Returns success status and per-command output.",
    inputSchema: z.object({
      /** Risk level computed by `classify_commit_risk`. Determines which suite to run. */
      riskLevel: z.enum(["low", "medium", "high"]).describe("Risk level determines which suite to run"),
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
        return { dryRun: true, results: [], allPassed: true }
      }

      // Map each risk level to its configured command list from config.validation.
      const suites: Record<RiskLevel, string[]> = {
        low: config.validation.low,
        medium: config.validation.medium,
        high: config.validation.high,
      }

      // Combine the standard suite with any caller-provided extra commands.
      const commands = [...suites[riskLevel], ...extraCommands]
      // Execute each command in order, stopping on the first failure.
      const results = runValidationSuite(commands, config.workingDir)
      const allPassed = results.every((r) => r.success)

      return { riskLevel, results, allPassed }
    },
    // 5-minute overall timeout for the entire suite (individual commands have 2-min timeouts).
    timeoutMs: 300_000,
  })
}
