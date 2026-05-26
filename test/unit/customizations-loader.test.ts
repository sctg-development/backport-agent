import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCustomizationPaths, loadCustomizations } from "../../src/customizations/loader.js"

describe("customizations loader", () => {
  const originalEnv = { ...process.env }
  const tempDirs: string[] = []

  afterEach(() => {
    process.env = { ...originalEnv }
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("loads YAML customizations and flattens paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "backport-customizations-"))
    tempDirs.push(dir)

    const yamlPath = join(dir, "customizations.yaml")
    writeFileSync(
      yamlPath,
      [
        "customizations:",
        "  - id: keypoollive-provider",
        "    description: keypoollive provider",
        "    paths:",
        "      - src/providers/keypoollive/**",
        "      - src/providers/index.ts",
        "    invariants:",
        "      - provider remains registered",
        "  - id: package-renaming",
        "    description: package rename rules",
        "    paths:",
        "      - .github/workflows/**",
        "    invariants:",
        "      - uses @sctg scope",
      ].join("\n"),
      "utf-8",
    )

    const customizations = loadCustomizations(yamlPath)
    const paths = getCustomizationPaths(customizations)

    expect(customizations.customizations).toHaveLength(2)
    expect(paths).toEqual([
      "src/providers/keypoollive/**",
      "src/providers/index.ts",
      ".github/workflows/**",
    ])
  })

  it("uses BACKPORT_CUSTOMIZATIONS when path is not provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "backport-customizations-env-"))
    tempDirs.push(dir)

    const yamlPath = join(dir, "customizations.yaml")
    writeFileSync(
      yamlPath,
      [
        "customizations:",
        "  - id: one",
        "    description: one",
        "    paths:",
        "      - src/**",
        "    invariants:",
        "      - keep behavior",
      ].join("\n"),
      "utf-8",
    )

    process.env.BACKPORT_CUSTOMIZATIONS = yamlPath

    const customizations = loadCustomizations()
    expect(customizations.customizations[0].id).toBe("one")
  })
})
