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

/// <reference types="node" />
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../src/config/loader.js"

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe("loadConfig", () => {
  const originalEnv = { ...process.env }
  const originalCwd = process.cwd()
  const tempDirs: string[] = []

  afterEach(() => {
    process.env = { ...originalEnv }
    process.chdir(originalCwd)

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("loads config from explicit path and applies defaults", () => {
    const dir = makeTempDir("backport-config-explicit-")
    tempDirs.push(dir)

    const configPath = join(dir, "my-config.json")
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          upstream: { repo: "cline/cline", branch: "dev" },
          fork: { repo: "TEA-ching/cline", branch: "keypool-live" },
          workingDir: "/tmp/repo",
          models: { provider: "keypoollive" },
        },
        null,
        2,
      ),
      "utf-8",
    )

    const config = loadConfig(configPath)

    expect(config.upstream.remote).toBe("upstream")
    expect(config.fork.remote).toBe("origin")
    expect(config.sync.maxCommitsPerRun).toBe(20)
    expect(config.models.fast).toBe("mistral/devstral-latest")
    expect(config.validation.low).toEqual(["npm run typecheck"])
  })

  it("uses BACKPORT_CONFIG when no explicit path is provided", () => {
    const dir = makeTempDir("backport-config-env-")
    tempDirs.push(dir)

    const configPath = join(dir, "env-config.json")
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          upstream: { repo: "cline/cline", branch: "dev" },
          fork: { repo: "TEA-ching/cline", branch: "keypool-live" },
          workingDir: "/tmp/repo",
          models: { provider: "keypoollive" },
          sync: { dryRun: false },
        },
        null,
        2,
      ),
      "utf-8",
    )

    process.env.BACKPORT_CONFIG = configPath
    process.env.DRY_RUN = "true"

    const config = loadConfig()

    expect(config.sync.dryRun).toBe(true)
  })

  it("falls back to config.json in current working directory", () => {
    const dir = makeTempDir("backport-config-cwd-")
    tempDirs.push(dir)

    const configPath = join(dir, "config.json")
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          upstream: { repo: "cline/cline", branch: "dev" },
          fork: { repo: "TEA-ching/cline", branch: "keypool-live" },
          workingDir: "/tmp/repo",
          models: { provider: "keypoollive" },
        },
        null,
        2,
      ),
      "utf-8",
    )

    delete process.env.BACKPORT_CONFIG
    process.chdir(dir)

    const config = loadConfig()

    expect(config.workingDir).toBe("/tmp/repo")
  })
})
