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
 * @file validation/commands.ts
 *
 * Allowlist-based command runner for the validation suite.
 *
 * **Security model:**
 * The LLM agent may suggest commands to run during validation.  To prevent
 * arbitrary code execution, every command is checked against a fixed prefix
 * allowlist before being executed.  Only standard package-manager test scripts
 * and well-known CLI tools are permitted.  The allowlist is hard-coded in this
 * file and cannot be extended by the agent at runtime.
 *
 * **No shell interpolation:**
 * Commands are tokenized with a quote-aware splitter (`splitCommand`) and
 * executed via `execFileSync(bin, args[])` (not through a shell).  This
 * preserves arguments that contain spaces when wrapped in single or double
 * quotes, and prevents shell metacharacter injection for allowlisted commands.
 *
 * **Failure fast:**
 * `runValidationSuite` stops at the first failing command so that the agent
 * receives a clear, actionable error rather than a wall of cascading output.
 */

import { execFileSync } from "node:child_process"

/**
 * Result of running a single validation command.
 */
export type CommandResult = {
  /** The original command string that was (attempted to be) executed. */
  command: string
  /** `true` if the command exited with code 0. */
  success: boolean
  /** Process exit code.  `1` is used when the command was blocked by the allowlist. */
  exitCode: number
  /** Combined stdout + stderr output from the process (or the block reason). */
  output: string
}

/**
 * Hard-coded allowlist of command prefixes that the agent is permitted to execute.
 *
 * A command is allowed if and only if it starts with one of these strings.
 * The list is intentionally conservative:
 *  - `"npm run "`     — npm scripts defined in package.json
 *  - `"pnpm run "`    — pnpm equivalent
 *  - `"yarn run "`    — yarn equivalent
 *  - `"npx tsc"`      — TypeScript type-checker
 *  - `"npx eslint"`   — ESLint linter
 *  - `"npx vitest"`   — Vitest unit test runner
 *  - `"node --version"` — Non-destructive version probe (useful for diagnostics)
 */
export const ALLOWED_COMMAND_PREFIXES = [
  "npm run ",
  "pnpm run ",
  "yarn run ",
  "bun run ",
  "bun install",
  "npx tsc",
  "npx eslint",
  "npx vitest",
  "node --version",
]

/**
 * Splits a command string into tokens, respecting single and double quotes so
 * that arguments containing spaces are treated as a single token.
 *
 * Examples:
 *  - `"npm run typecheck"` → `["npm", "run", "typecheck"]`
 *  - `"npx eslint src --rule 'no-console: error'"` → `["npx", "eslint", "src", "--rule", "no-console: error"]`
 *
 * Escape sequences inside quotes are intentionally not supported because the
 * allowlist only permits a narrow, well-known set of commands.
 *
 * @param command - Raw command string as provided by the agent.
 * @returns Array of string tokens: `[binary, ...args]`.
 */
function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let inSingle = false
  let inDouble = false
  for (const ch of command) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        parts.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current) parts.push(current)
  return parts
}


/**
 * Returns `true` if the command starts with an allowlisted prefix.
 *
 * The check is intentionally a simple `startsWith` — it does not parse the
 * full command.  This makes the allowlist easy to audit.
 *
 * @param command - The full command string to check.
 * @returns `true` if the command is allowed, `false` if it should be blocked.
 */
export function isAllowedCommand(command: string): boolean {
  return ALLOWED_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix))
}

/**
 * Runs a single validation command and returns its result.
 *
 * If the command is not on the allowlist, it is immediately blocked and a
 * descriptive error is returned without executing anything.
 *
 * Execution details:
 *  - `stdio: ["pipe","pipe","pipe"]` — all streams are captured, not printed.
 *  - `timeout: 120_000` ms — commands are killed if they take more than 2 minutes.
 *  - No `shell: true` — the command is parsed by whitespace split and executed directly.
 *
 * @param command - Full command string, e.g. `"npm run typecheck"`.
 * @param cwd     - Absolute working directory in which to run the command.
 * @returns A `CommandResult` with the success flag, exit code, and captured output.
 */
export function runValidationCommand(command: string, cwd: string): CommandResult {
  // Security gate: reject any command not matching the allowlist.
  if (!isAllowedCommand(command)) {
    return {
      command,
      success: false,
      exitCode: 1,
      output: `Blocked: command "${command}" is not in the allowed list`,
    }
  }

  // Split into [binary, ...args] using a quote-aware tokenizer so that arguments
  // containing spaces (wrapped in quotes) are preserved as single tokens.
  // Commands are then executed via execFileSync without a shell, preventing
  // metacharacter injection.
  const parts = splitCommand(command)
  const bin = parts[0]
  const args = parts.slice(1)

  try {
    const output = execFileSync(bin, args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      // 2-minute safety timeout — prevents hung test runners from blocking the agent.
      timeout: 120_000,
    })
    return { command, success: true, exitCode: 0, output }
  } catch (err: unknown) {
    // execFileSync throws when the process exits non-zero.  Extract diagnostic info.
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string }
    // Combine all output streams for maximum debuggability.
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n")
    return { command, success: false, exitCode: e.status ?? 1, output }
  }
}

/**
 * Runs an ordered list of validation commands, stopping on the first failure.
 *
 * "Fail fast" semantics are intentional: the agent should see the first broken
 * command and address it rather than drowning in cascading failures.
 *
 * @param commands - Ordered array of command strings to execute.
 * @param cwd      - Absolute working directory for all commands.
 * @returns Array of `CommandResult` objects, one per executed command.
 *          If a command fails, no subsequent commands are executed.
 */
export function runValidationSuite(commands: string[], cwd: string): CommandResult[] {
  const results: CommandResult[] = []
  for (const command of commands) {
    const result = runValidationCommand(command, cwd)
    results.push(result)
    // Stop on first failure — no point running further checks.
    if (!result.success) break
  }
  return results
}
