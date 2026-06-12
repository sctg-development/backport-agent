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
 * @file args.ts
 *
 * CLI argument parsing and help functionality for the Backport Agent.
 * Handles command-line argument extraction, validation, and help display.
 */
/// <reference types="node" />

// ---------------------------------------------------------------------------
// CLI argument parsing — runs before .env loading so flags can override env.
// ---------------------------------------------------------------------------

/**
 * Parses command line arguments and sets up environment variables.
 * This runs before .env loading so CLI flags can override environment variables.
 */
export function parseCliArgs(): void {
  const argv = process.argv.slice(2)

  function getArgValue(name: string): string | undefined {
    const idx = argv.indexOf(name)
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined
  }

  function hasFlag(name: string): boolean {
    return argv.includes(name)
  }

  function isHelpRequest(): boolean {
    return hasFlag("--help") || hasFlag("-h")
  }

  function printHelp(): void {
    console.log(`Backport Agent CLI

Usage:
  backport-agent [options]

Options:
  --help, -h                            Show this help message
  --config <path>                       Path to config.json
  --backport-customizations <path|url>  Override customizations source
  --provider <id>                       Override config.models.provider
                                        (e.g. anthropic, openai, mistral, gemini, keypoollive)
  --api-key <key>                       Override config.models.apiKey
                                        Use \$ENV_VAR syntax to read from an env variable
  --list-backport-needed                Print pending upstream commits and exit (no agent run)
  --dry-run                             Run without pushing changes
  --verbose                             Enable verbose logs

keypoollive provider options:
  --keypool-vault-url <url>             Override KEYPOOL_VAULT_URL
  --keypool-live-secret <secret>        Override KEYPOOL_LIVE_SECRET
  --keypool-state-file <path>           Override KEYPOOL_STATE_FILE

Note: config.json is only required for an actual run; this help text works without a config file.
All --provider/--api-key flags take precedence over values in config.json.
`)
  }

  if (isHelpRequest()) {
    printHelp()
    process.exit(0)
  }

  if (hasFlag("--verbose")) process.env.VERBOSE = "true"
  if (hasFlag("--dry-run")) process.env.DRY_RUN = "true"
  if (hasFlag("--list-backport-needed")) process.env._CLI_LIST_BACKPORT_NEEDED = "true"
  const cliConfig = getArgValue("--config")
  if (cliConfig) process.env._CLI_CONFIG_PATH = cliConfig
  const cliCustomizations = getArgValue("--backport-customizations")
  if (cliCustomizations) process.env.BACKPORT_CUSTOMIZATIONS = cliCustomizations
  const cliProvider = getArgValue("--provider")
  if (cliProvider) process.env._CLI_PROVIDER = cliProvider
  const cliApiKey = getArgValue("--api-key")
  if (cliApiKey) process.env._CLI_API_KEY = cliApiKey
  // keypoollive-specific env var overrides
  const cliVaultUrl = getArgValue("--keypool-vault-url")
  if (cliVaultUrl) process.env.KEYPOOL_VAULT_URL = cliVaultUrl
  const cliLiveSecret = getArgValue("--keypool-live-secret")
  if (cliLiveSecret) process.env.KEYPOOL_LIVE_SECRET = cliLiveSecret
  const cliStateFile = getArgValue("--keypool-state-file")
  if (cliStateFile) process.env.KEYPOOL_STATE_FILE = cliStateFile
}