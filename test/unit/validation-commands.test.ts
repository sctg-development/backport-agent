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
