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
