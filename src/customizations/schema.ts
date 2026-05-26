/**
 * @file customizations/schema.ts
 *
 * Zod schema for the agent's customizations manifest (customizations.yaml).
 *
 * Each "customization entry" describes a deliberate deviation from upstream:
 * which file paths it covers, what invariants must remain intact after a sync,
 * and optional shell commands that can verify the customization is still working.
 *
 * The agent uses this manifest to:
 *  1. Detect when an upstream commit touches a customization zone (risk classification).
 *  2. Guide conflict resolution — the LLM knows which files carry fork-specific logic.
 *  3. Produce human-readable PR comments that explain why certain files need review.
 */

import { z } from "zod"

/**
 * Schema for a single customization entry in the manifest.
 *
 * Example YAML entry:
 * ```yaml
 * - id: keypoollive-provider-vscode
 *   description: "Registers the keypoollive LLM provider inside the VS Code extension"
 *   paths:
 *     - src/api/providers/keypoollive.ts
 *     - src/shared/providers/providers.json
 *   invariants:
 *     - "keypoollive must remain listed in providers.json"
 *   testCommands:
 *     - "npm run typecheck"
 * ```
 */
export const CustomizationEntrySchema = z.object({
  /**
   * Short machine-readable identifier for this customization, e.g. `"keypoollive-provider-vscode"`.
   * Used in risk reports and decision logs to unambiguously reference the entry.
   */
  id: z.string(),

  /**
   * Human-readable description of what this customization does and why it exists.
   * Surfaced in PR comments and agent decision logs.
   */
  description: z.string(),

  /**
   * Glob patterns (relative to the repository root) that cover the files owned
   * by this customization.  Any upstream commit touching one of these paths will
   * be classified as high risk.
   *
   * Standard minimatch syntax is supported, e.g. `"src/api/providers/keypoollive/**"`.
   */
  paths: z.array(z.string()).describe("Glob patterns relative to repo root"),

  /**
   * Ordered list of invariants that must remain true after every sync.
   * The agent checks these conceptually during conflict resolution and includes
   * them in the PR body so human reviewers know what to verify.
   *
   * Example: `"The SCTG_KEY_VAULT_URL constant must not be removed."`
   */
  invariants: z.array(z.string()).describe("Human-readable invariants that must remain true after sync"),

  /**
   * Optional shell commands to run in order to verify this specific customization
   * is still intact after a sync.  These are appended to the validation suite when
   * the commit risk level is "high" and this customization is affected.
   *
   * Commands must still match the global allowlist in `validation/commands.ts`.
   */
  testCommands: z.array(z.string()).optional().describe("Commands to verify this customization still works"),
})

/**
 * Schema for the entire customizations manifest file.
 * The top-level key `customizations` holds the array of entries.
 */
export const CustomizationsSchema = z.object({
  /** Array of all known fork customizations. May be empty if the fork has no deviations. */
  customizations: z.array(CustomizationEntrySchema),
})

/**
 * TypeScript type for a single customization entry, inferred from `CustomizationEntrySchema`.
 */
export type CustomizationEntry = z.infer<typeof CustomizationEntrySchema>

/**
 * TypeScript type for the full customizations manifest, inferred from `CustomizationsSchema`.
 */
export type Customizations = z.infer<typeof CustomizationsSchema>
