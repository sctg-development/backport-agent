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
/// <reference types="vitest" />
import "dotenv/config"
import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, createBuiltinTools, createDefaultExecutors } from "@sctg/cline-sdk"

const hasVaultEnv = Boolean(process.env.KEYPOOL_VAULT_URL && process.env.KEYPOOL_LIVE_SECRET)
const MODEL_ID = "mistral/devstral-latest"
const FAST_MODEL_ID = "mistral/codestral-latest"
const integration = hasVaultEnv ? it : it.skip

function createAgentWithTools(options: {
  cwd: string
  enableReadFiles?: boolean
  enableSearch?: boolean
  enableBash?: boolean
}) {
  const executors = createDefaultExecutors({
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
    "regression: mistral/devstral tool-call survives second turn and completes",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "backport-mistral-devstral-regression-"))
      tempDirs.push(dir)

      const targetFile = join(dir, "probe.txt")
      writeFileSync(targetFile, "hello from regression test\n", "utf-8")

      const agent = new Agent({
        providerId: "keypoollive",
        modelId: MODEL_ID,
        apiKey: "auto",
        systemPrompt:
          "You are a strict test runner. Always call the requested tool first, then answer exactly DONE.",
        tools: createBuiltinTools({
          cwd: dir,
          enableReadFiles: true,
          enableSearch: false,
          enableBash: false,
          enableWebFetch: false,
          enableApplyPatch: false,
          enableEditor: false,
          enableSkills: false,
          enableAskQuestion: false,
          enableSubmitAndExit: false,
          executors: createDefaultExecutors({}),
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
          `Use read_files on ${targetFile}.`,
          "After reading the file, reply with exactly DONE.",
        ].join("\n"),
      )

      expect(toolNames).toContain("read_files")
      expect(result.status).toBe("completed")
      expect(result.error).toBeFalsy()
      expect((result.outputText ?? "").trim().toLowerCase()).toContain("done")
    },
  )

  integration(
    "regression: mistral/codestral tool-call survives second turn and completes",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "backport-mistral-codestral-regression-"))
      tempDirs.push(dir)

      const targetFile = join(dir, "probe.txt")
      writeFileSync(targetFile, "hello from regression test\n", "utf-8")

      const agent = new Agent({
        providerId: "keypoollive",
        modelId: FAST_MODEL_ID,
        apiKey: "auto",
        systemPrompt:
          "You are a strict test runner. Always call the requested tool first, then answer exactly DONE.",
        tools: createBuiltinTools({
          cwd: dir,
          enableReadFiles: true,
          enableSearch: false,
          enableBash: false,
          enableWebFetch: false,
          enableApplyPatch: false,
          enableEditor: false,
          enableSkills: false,
          enableAskQuestion: false,
          enableSubmitAndExit: false,
          executors: createDefaultExecutors({}),
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
          `Use read_files on ${targetFile}.`,
          "After reading the file, reply with exactly DONE.",
        ].join("\n"),
      )

      expect(toolNames).toContain("read_files")
      expect(result.status).toBe("completed")
      expect(result.error).toBeFalsy()
      expect((result.outputText ?? "").trim().toLowerCase()).toContain("done")
    },
  )

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
          executors: createDefaultExecutors({}),
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
          executors: createDefaultExecutors({}),
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
          executors: createDefaultExecutors({}),
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
