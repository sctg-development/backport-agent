/**
 * @file customizations/loader.ts
 *
 * Loads and validates the customizations manifest from a YAML file.
 *
 * Resolution order for the manifest path (first match wins):
 *  1. Explicit `customizationsPath` argument passed by the caller.
 *  2. The `BACKPORT_CUSTOMIZATIONS` environment variable.
 *  3. `customizations.yaml` in the current working directory.
 *
 * The file is parsed with `js-yaml` and then validated against
 * `CustomizationsSchema` via Zod.  A `ZodError` is thrown if the structure
 * is invalid, providing a clear description of what is wrong.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import yaml from "js-yaml"
import { CustomizationsSchema, type Customizations } from "./schema.js"

/**
 * Read, parse, and validate the customizations YAML manifest.
 *
 * @param customizationsPath - Optional explicit path to a `customizations.yaml` file.
 *                             Falls back to `BACKPORT_CUSTOMIZATIONS` env var,
 *                             then `./customizations.yaml` in the cwd.
 * @returns A fully validated `Customizations` object.
 * @throws {Error} If the file cannot be read.
 * @throws {ZodError} If the YAML structure does not satisfy `CustomizationsSchema`.
 */
export function loadCustomizations(customizationsPath?: string): Customizations {
  // Determine which file to read, in priority order.
  const path =
    customizationsPath ?? process.env.BACKPORT_CUSTOMIZATIONS ?? resolve(process.cwd(), "customizations.yaml")

  // Parse YAML — js-yaml.load returns `unknown`, so we hand it to Zod for validation.
  const raw = yaml.load(readFileSync(path, "utf-8"))
  return CustomizationsSchema.parse(raw)
}

/**
 * Flatten all glob patterns from every customization entry into a single array.
 *
 * Useful as a quick pre-filter: if a changed file matches any of these patterns
 * the caller knows it needs deeper per-entry inspection.
 *
 * @param customizations - Validated customizations manifest.
 * @returns Deduplicated flat array of all glob patterns across all entries.
 */
export function getCustomizationPaths(customizations: Customizations): string[] {
  // flatMap collapses the nested arrays from each entry's `paths` field.
  return customizations.customizations.flatMap((c) => c.paths)
}
