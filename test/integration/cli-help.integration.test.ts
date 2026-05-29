import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

describe("CLI help", () => {
  it("prints help without requiring config.json", () => {
    const tsxBin = resolve(process.cwd(), "node_modules", ".bin", "tsx")
    const script = resolve(process.cwd(), "src", "main.ts")

    const output = execFileSync(
      tsxBin,
      [script, "--help"],
      {
        env: { ...process.env, NODE_OPTIONS: "" },
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    expect(output).toContain("Backport Agent CLI")
    expect(output).toContain("--help")
  })
})
