/**
 * @file config/loader.ts
 *
 * Loads and validates the agent's main configuration from a JSON file.
 *
 * Resolution order for the config path (first match wins):
 *  1. Explicit `configPath` argument passed by the caller.
 *  2. The `BACKPORT_CONFIG` environment variable.
 *  3. `config.json` in the current working directory.
 *
 * Environment variable overrides applied after parsing:
 *  - `DRY_RUN=true`       → forces `sync.dryRun = true` regardless of the JSON value.
 *  - `_CLI_PROVIDER=<id>` → overrides `models.provider` (set by `--provider` flag).
 *  - `_CLI_API_KEY=<key>` → overrides `models.apiKey` (set by `--api-key` flag).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { SyncConfigSchema, type SyncConfig } from "./schema.js"

/**
 * Read, parse, and validate the agent configuration file.
 *
 * The raw JSON is parsed first, then any environment-variable overrides are
 * merged in before the result is validated through `SyncConfigSchema.parse()`.
 * Zod will throw a descriptive `ZodError` if required fields are missing or
 * have the wrong type.
 *
 * @param configPath - Optional explicit path to a `config.json` file.
 *                     Falls back to `BACKPORT_CONFIG` env var, then `./config.json`.
 * @returns A fully validated `SyncConfig` object with all defaults applied.
 * @throws {Error} If the file cannot be read or cannot be parsed as JSON.
 * @throws {ZodError} If the JSON structure does not satisfy `SyncConfigSchema`.
 */
export function loadConfig(configPath?: string): SyncConfig {
  // Determine which config file to read, in priority order.
  const path = configPath ?? process.env.BACKPORT_CONFIG ?? resolve(process.cwd(), "config.json")

  // Read synchronously — startup is blocking by design; no need for async here.
  const raw = JSON.parse(readFileSync(path, "utf-8"))

  // Ensure optional top-level sections exist so nested defaults are always applied.
  raw.sync ??= {}
  raw.models ??= {}
  raw.validation ??= {}

  // Environment variable overrides — applied before Zod validation so that
  // field-level constraints (e.g. type checks) still apply to the final values.
  // KEYPOOL_VAULT_URL / KEYPOOL_LIVE_SECRET are consumed directly by the
  // keypoollive provider SDK — they are not stored in the schema.

  if (process.env.DRY_RUN === "true") {
    // Allow CI pipelines to safely test the agent without pushing anything.
    raw.sync = { ...(raw.sync ?? {}), dryRun: true }
  }

  // --provider CLI flag: overrides config.models.provider
  if (process.env._CLI_PROVIDER) {
    raw.models = { ...(raw.models ?? {}), provider: process.env._CLI_PROVIDER }
  }

  // --api-key CLI flag: overrides config.models.apiKey
  if (process.env._CLI_API_KEY) {
    raw.models = { ...(raw.models ?? {}), apiKey: process.env._CLI_API_KEY }
  }

  // Validate and apply defaults.  SyncConfigSchema.parse() throws on invalid input.
  return SyncConfigSchema.parse(raw)
}
