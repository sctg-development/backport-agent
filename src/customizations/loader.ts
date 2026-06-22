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
 * @file customizations/loader.ts
 *
 * Loads and validates the customizations manifest from multiple sources.
 *
 * Resolution order for the manifest (first match wins):
 *  1. Explicit `source` argument passed by the caller.
 *     - `string` starting with `http://` or `https://` → fetched via HTTP GET.
 *     - `string` (other) → read from the local filesystem.
 *     - `object` → used directly as the parsed manifest (JSON/inline form).
 *  2. The `BACKPORT_CUSTOMIZATIONS` environment variable (file path).
 *  3. `customizations.yaml` in the current working directory.
 *
 * The resolved value is parsed with `js-yaml` when it comes from a string/URL,
 * then validated against `CustomizationsSchema` via Zod.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { load as jsYamlLoad } from "js-yaml"
import { CustomizationsSchema, type Customizations } from "./schema.js"

/**
 * Read, parse, and validate the customizations manifest.
 *
 * @param source - Optional source: a file path, an HTTP(S) URL, or an inline object.
 *                 Falls back to `BACKPORT_CUSTOMIZATIONS` env var, then `./customizations.yaml`.
 * @returns A fully validated `Customizations` object.
 * @throws {Error} If the file/URL cannot be read.
 * @throws {ZodError} If the structure does not satisfy `CustomizationsSchema`.
 */
export async function loadCustomizations(source?: string | Record<string, unknown>): Promise<Customizations> {
  // --- Inline object: already parsed, validate directly ---
  if (source !== undefined && typeof source === "object") {
    return CustomizationsSchema.parse(source)
  }

  // --- Resolve string source ---
  const strSource =
    source ?? process.env.BACKPORT_CUSTOMIZATIONS ?? resolve(process.cwd(), "customizations.yaml")

  let raw: unknown

  if (typeof strSource === "string" && (strSource.startsWith("http://") || strSource.startsWith("https://"))) {
    // URL: fetch via HTTP GET
    const response = await fetch(strSource)
    if (!response.ok) {
      throw new Error(`Failed to fetch customizations from ${strSource}: HTTP ${response.status} ${response.statusText}`)
    }
    const text = await response.text()
    raw = jsYamlLoad(text)
  } else {
    // Local file path
    raw = jsYamlLoad(readFileSync(strSource as string, "utf-8"))
  }

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
