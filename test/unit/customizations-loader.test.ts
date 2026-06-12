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

  it("loads YAML customizations and flattens paths", async () => {
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

    const customizations = await loadCustomizations(yamlPath)
    const paths = getCustomizationPaths(customizations)

    expect(customizations.customizations).toHaveLength(2)
    expect(paths).toEqual([
      "src/providers/keypoollive/**",
      "src/providers/index.ts",
      ".github/workflows/**",
    ])
  })

  it("uses BACKPORT_CUSTOMIZATIONS when path is not provided", async () => {
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

    const customizations = await loadCustomizations()
    expect(customizations.customizations[0].id).toBe("one")
  })
})
