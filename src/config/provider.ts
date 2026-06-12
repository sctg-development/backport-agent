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
 * @file provider.ts
 *
 * Provider configuration and API key resolution for the Backport Agent.
 * Handles the resolution of API keys from multiple sources with proper fallback.
 */
import type { SyncConfig } from "./schema.js";

/**
 * Resolves the API key for the LLM provider from the agent config.
 *
 * Resolution order:
 *  1. `_CLI_API_KEY` env var (set by the `--api-key` CLI flag).
 *  2. `config.models.apiKey` literal value (no `$` prefix).
 *  3. `config.models.apiKey` env-var reference: `"$ENV_VAR"` → `process.env[ENV_VAR]`.
 *  4. Implicit convention: `{PROVIDER_UPPER}_API_KEY` env var
 *     (e.g. `ANTHROPIC_API_KEY` for provider `"anthropic"`).
 *  5. `undefined` — the SDK will attempt its own credential discovery.
 */
export function resolveApiKey(config: SyncConfig): string | undefined {
  // CLI flag takes highest priority
  if (process.env._CLI_API_KEY) return process.env._CLI_API_KEY
  const { provider, apiKey } = config.models
  if (apiKey !== undefined) {
    return apiKey.startsWith("$") ? process.env[apiKey.slice(1)] : apiKey
  }
  const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`
  return process.env[envKey]
}