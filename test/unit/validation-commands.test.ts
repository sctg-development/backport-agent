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

import { describe, expect, it } from "vitest"
import {
  ALLOWED_COMMAND_PREFIXES,
  isAllowedCommand,
  runValidationCommand,
  runValidationSuite,
} from "../../src/validation/commands.js"

describe("validation commands", () => {
  it("has a conservative allowlist", () => {
    expect(ALLOWED_COMMAND_PREFIXES).toContain("npm run ")
    expect(ALLOWED_COMMAND_PREFIXES).toContain("node --version")
  })

  it("accepts allowed commands and rejects non-allowed commands", () => {
    expect(isAllowedCommand("npm run typecheck")).toBe(true)
    expect(isAllowedCommand("node --version")).toBe(true)
    expect(isAllowedCommand("echo hacked")).toBe(false)
  })

  it("blocks disallowed commands without executing them", () => {
    const result = runValidationCommand("echo should-not-run", process.cwd())

    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Blocked")
  })

  it("runs an allowed command successfully", () => {
    const result = runValidationCommand("node --version", process.cwd())

    expect(result.success).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.output.trim().length).toBeGreaterThan(0)
  })

  it("stops at first failure in runValidationSuite", () => {
    const results = runValidationSuite(
      ["node --version", "echo blocked", "node --version"],
      process.cwd(),
    )

    expect(results).toHaveLength(2)
    expect(results[0].success).toBe(true)
    expect(results[1].success).toBe(false)
  })
})
