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
export const CustomizationEntrySchema = z
  .object({
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
     * is still intact after a sync.  These run through `runTrustedSuite` (they are
     * user-authored config, same trust level as `config.validation.*`) when the
     * agent passes the matching customization IDs to `run_validation`.
     *
     * `tests` is accepted as an alias — both keys feed the same field.
     */
    testCommands: z.array(z.string()).optional().describe("Commands to verify this customization still works"),

    /** Alias for `testCommands` (the field name used by several real-world manifests). */
    tests: z.array(z.string()).optional().describe("Alias for testCommands"),

    /**
     * Files that interact with this customization without being owned by it
     * (registration points, conversion tables, UI wiring…).  Upstream changes to
     * these paths are classified as at least medium risk and the list is surfaced
     * to the AI tools as context.  `related_files` is accepted as an alias.
     */
    relatedFiles: z.array(z.string()).optional().describe("Related file globs (registration points, wiring)"),

    /** Alias for `relatedFiles` (snake_case form used by YAML manifests). */
    related_files: z.array(z.string()).optional().describe("Alias for relatedFiles"),
  })
  .transform(({ tests, related_files, testCommands, relatedFiles, ...rest }) => ({
    ...rest,
    // Canonicalize aliases: explicit camelCase key wins, alias fills the gap.
    testCommands: testCommands ?? tests,
    relatedFiles: relatedFiles ?? related_files,
  }))

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
