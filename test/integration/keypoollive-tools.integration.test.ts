import "dotenv/config"
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, createBuiltinTools, createDefaultExecutors } from "@sctg/cline-sdk"

const hasVaultEnv = Boolean(process.env.KEYPOOL_VAULT_URL && process.env.KEYPOOL_LIVE_SECRET)
const MODEL_ID = "mistral/devstral-latest"
const integration = hasVaultEnv ? it : it.skip

function createAgentWithTools(options: {
  cwd: string
  enableReadFiles?: boolean
  enableSearch?: boolean
  enableBash?: boolean
}) {
  const executors = createDefaultExecutors({
    cwd: options.cwd,
  })

  return new Agent({
    providerId: "keypoollive",
    modelId: MODEL_ID,
    apiKey: "auto",
    systemPrompt:
      "You are a precise coding agent. Always use the tools that are available and then answer with a short, direct result.",
    tools: createBuiltinTools({
      cwd: options.cwd,
      enableReadFiles: options.enableReadFiles ?? false,
      enableSearch: options.enableSearch ?? false,
      enableBash: options.enableBash ?? false,
      enableWebFetch: false,
      enableApplyPatch: false,
      enableEditor: false,
      enableSkills: false,
      enableAskQuestion: false,
      enableSubmitAndExit: false,
      executors: {
        readFile: executors.readFile,
        search: executors.search,
        bash: executors.bash,
      },
    }),
  })
}

describe("keypoollive real tool integrations", () => {
  const cwd = process.cwd()
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  integration(
    "uses read_files and search_codebase through the real SDK tools",
    { timeout: 180_000 },
    async () => {
      const agent = createAgentWithTools({
        cwd,
        enableReadFiles: true,
        enableSearch: true,
      })

      const toolNames: string[] = []
      agent.subscribe((event) => {
        if (event.type === "tool-started") {
          toolNames.push(event.toolCall.toolName)
        }
      })

      const packageJsonPath = `${cwd}/package.json`
      const result = await agent.run(
        [
          `Use read_files on ${packageJsonPath}.`,
          'Use search_codebase to find the string "test:integration" in this workspace.',
          'After both tools have been called, answer with one sentence that includes the package name from package.json and the exact script name you found.',
        ].join("\n"),
      )

      const output = (result.outputText ?? "").toLowerCase()

      expect(toolNames).toContain("read_files")
      expect(toolNames).toContain("search_codebase")
      expect(output).toContain("@sctg/backport-agent")
      expect(output).toContain("test:integration")
    },
  )

  integration(
    "uses run_commands through the real SDK tool",
    { timeout: 180_000 },
    async () => {
      const agent = createAgentWithTools({
        cwd,
        enableBash: true,
      })

      const toolNames: string[] = []
      agent.subscribe((event) => {
        if (event.type === "tool-started") {
          toolNames.push(event.toolCall.toolName)
        }
      })

      const result = await agent.run(
        'Use run_commands to execute "node --version" in the workspace and then reply with the exact version string you observed.',
      )

      const output = (result.outputText ?? "").trim()

      expect(toolNames).toContain("run_commands")
      expect(output).toMatch(/v\d+\.\d+\.\d+/)
    },
  )

  integration(
    "uses fetch_web_content through the real SDK tool",
    { timeout: 180_000 },
    async () => {
      const agent = new Agent({
        providerId: "keypoollive",
        modelId: MODEL_ID,
        apiKey: "auto",
        systemPrompt:
          "You are a precise coding agent. Always use the tools that are available and then answer with a short, direct result.",
        tools: createBuiltinTools({
          cwd,
          enableReadFiles: false,
          enableSearch: false,
          enableBash: false,
          enableWebFetch: true,
          enableApplyPatch: false,
          enableEditor: false,
          enableSkills: false,
          enableAskQuestion: false,
          enableSubmitAndExit: false,
          executors: createDefaultExecutors({ cwd }),
        }),
      })

      const toolNames: string[] = []
      agent.subscribe((event) => {
        if (event.type === "tool-started") {
          toolNames.push(event.toolCall.toolName)
        }
      })

      const result = await agent.run(
        'Use fetch_web_content to fetch https://example.com and then reply with the exact title of the page.',
      )

      const output = (result.outputText ?? "").toLowerCase()

      expect(toolNames).toContain("fetch_web_content")
      expect(output).toContain("example domain")
    },
  )

  integration(
    "uses apply_patch through the real SDK tool",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "backport-apply-patch-"))
      tempDirs.push(dir)

      const targetFile = join(dir, "note.txt")
      writeFileSync(targetFile, "alpha\n", "utf-8")

      const agent = new Agent({
        providerId: "keypoollive",
        modelId: MODEL_ID,
        apiKey: "auto",
        systemPrompt:
          "You are a precise coding agent. Always use the tools that are available and then answer with a short, direct result.",
        tools: createBuiltinTools({
          cwd: dir,
          enableReadFiles: false,
          enableSearch: false,
          enableBash: false,
          enableWebFetch: false,
          enableApplyPatch: true,
          enableEditor: false,
          enableSkills: false,
          enableAskQuestion: false,
          enableSubmitAndExit: false,
          executors: createDefaultExecutors({ cwd: dir }),
        }),
      })

      const toolNames: string[] = []
      agent.subscribe((event) => {
        if (event.type === "tool-started") {
          toolNames.push(event.toolCall.toolName)
        }
      })

      const result = await agent.run(
        [
          `Use apply_patch to update ${targetFile}.`,
          "Apply exactly this patch:",
          "*** Begin Patch",
          `*** Update File: ${targetFile}`,
          "@@",
          "-alpha",
          "+alpha",
          "+beta",
          "*** End Patch",
          'After applying the patch, report the final two-line content.',
        ].join("\n"),
      )

      const fileContent = readFileSync(targetFile, "utf-8")

      expect(toolNames).toContain("apply_patch")
      expect(fileContent).toContain("alpha")
      expect(fileContent).toContain("beta")
      expect(fileContent.trim().split("\n")).toEqual(["alpha", "beta"])
      expect((result.outputText ?? "").toLowerCase()).toContain("beta")
    },
  )

  integration(
    "uses editor through the real SDK tool",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "backport-editor-"))
      tempDirs.push(dir)

      const targetFile = join(dir, "story.txt")
      writeFileSync(targetFile, "first line\nsecond line\n", "utf-8")

      const agent = new Agent({
        providerId: "keypoollive",
        modelId: MODEL_ID,
        apiKey: "auto",
        systemPrompt:
          "You are a precise coding agent. Always use the tools that are available and then answer with a short, direct result.",
        tools: createBuiltinTools({
          cwd: dir,
          enableReadFiles: false,
          enableSearch: false,
          enableBash: false,
          enableWebFetch: false,
          enableApplyPatch: false,
          enableEditor: true,
          enableSkills: false,
          enableAskQuestion: false,
          enableSubmitAndExit: false,
          executors: createDefaultExecutors({ cwd: dir }),
        }),
      })

      const toolNames: string[] = []
      agent.subscribe((event) => {
        if (event.type === "tool-started") {
          toolNames.push(event.toolCall.toolName)
        }
      })

      const result = await agent.run(
        [
          `Use editor to replace the text "second line" with "updated line" in ${targetFile}.`,
          'After editing, report the updated file content.',
        ].join("\n"),
      )

      const fileContent = readFileSync(targetFile, "utf-8")

      expect(toolNames).toContain("editor")
      expect(fileContent).toContain("updated line")
      expect(fileContent).not.toContain("second line")
      expect((result.outputText ?? "").toLowerCase()).toContain("updated line")
    },
  )
})
