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
 * @file agent-setup.ts
 *
 * Agent initialization and tool assembly for the Backport Agent.
 * Handles the creation and configuration of the agent with all necessary tools.
 */
import { Agent, createBuiltinTools, createUserInstructionConfigService } from "@sctg/cline-sdk"
import type { UserInstructionConfigRecord } from "@sctg/cline-sdk"
import { loadCustomizations } from "../customizations/loader.js"
import { makeGitTools } from "../git/git-tools.js"
import { makeRiskTool } from "../risk/risk-tools.js"
import { makeValidationTool } from "../validation/validation-tools.js"
import { makeGitHubTools } from "../github/github-tools.js"
import { makeReportTool } from "../reports/report-tools.js"
import { makeAiTools } from "../ai/ai-tools.js"
import type { SyncConfig } from "../config/schema.js"
import { SYSTEM_PROMPT } from "./system-prompt.js"
import { resolveApiKey } from "../config/provider.js"

interface AgentSetupParams {
  config: SyncConfig
  promptLogPath: string
  verbose: boolean
}

interface AgentSetupResult {
  agent: Agent
  userInstructionService: Awaited<ReturnType<typeof createUserInstructionConfigService>>
  keypoolStats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
    rotations: number
    exhaustions: number
    keysUsed: Set<string>
  }
}

export async function setupAgent(params: AgentSetupParams): Promise<AgentSetupResult> {
  const { config, promptLogPath, verbose } = params

  // --- Customization loading ---
  const customizations = await loadCustomizations(
    config.customizations ?? process.env.BACKPORT_CUSTOMIZATIONS,
  )

  // --- User instruction service setup ---
  const userInstructionService = createUserInstructionConfigService({
    skills: { workspacePath: config.workingDir },
  })

  await userInstructionService.start()

  // --- Tool assembly ---
  // Each factory returns one or more AgentTool instances bound to the config.
  const gitTools = makeGitTools(config)                 // 10 tools for git operations
  const riskTool = makeRiskTool(config, customizations) // 1 tool for risk classification
  const validationTool = makeValidationTool(config)     // 1 tool for validation suite
  const githubTools = makeGitHubTools(config)           // 3 tools for GitHub PR management
  const reportTool = makeReportTool(config, promptLogPath, config.models.provider, resolveApiKey(config)) // 1 terminal tool (completesRun: true)
  const aiTools = makeAiTools(config, promptLogPath, config.models.provider, resolveApiKey(config), customizations) // 4 AI-powered analysis tools

  // --- SDK built-in tools ---
  const builtinTools = createBuiltinTools({
    cwd: config.workingDir,
    enableReadFiles: true,
    enableSearch: true,
    enableBash: true,
    enableWebFetch: true,
    enableApplyPatch: true,
    enableEditor: true,
    enableSkills: true,
    enableAskQuestion: true,
    enableSubmitAndExit: true,
    executors: {
      // Resolve skills from the workspace through the SDK's user-instruction service.
      skills: async (skill: string, args: string | undefined) => {
        const configuredSkills = userInstructionService.listRecords("skill")
        const match = configuredSkills.find(
          (record: UserInstructionConfigRecord) => record.id === skill || record.item.name === skill || record.filePath === skill,
        )

        if (!match || match.item.disabled) {
          const availableSkills = configuredSkills
            .filter((record: UserInstructionConfigRecord) => !record.item.disabled)
            .map((record: UserInstructionConfigRecord) => record.item.name)

          return availableSkills.length > 0
            ? `Skill "${skill}" is not available. Known skills: ${availableSkills.join(", ")}`
            : `No configured skills are available in this backport-agent runtime.`
        }

        const parts = [
          `Skill: ${match.item.name}`,
          match.item.description ? `Description: ${match.item.description}` : null,
          args ? `Arguments: ${args}` : null,
          "Instructions:",
          match.item.instructions,
        ].filter(Boolean)

        return parts.join("\n")
      },
      // Headless CI mode: ask_question is surfaced but should not block runs.
      askQuestion: async (question: string, options: string[]) => {
        const normalizedOptions = options.length > 0 ? options.join(" | ") : "(no options)"
        return `Question recorded (headless mode): ${question} [${normalizedOptions}]`
      },
      // Keep submit_and_exit functional for compatibility with integrated flows.
      submit: async (summary: string, verified: boolean) =>
        `submit_and_exit acknowledged (verified=${verified ? "true" : "false"}): ${summary}`,
    },
  })

  // Flatten all tools into a single array for the Agent constructor.
  const allTools = [...builtinTools, ...gitTools, riskTool, validationTool, ...githubTools, reportTool, ...aiTools]

  // --- Keypool event handler (keypoollive provider only) ---
  // Provides real-time visibility into key selection, rotation, and token usage.
  // Accumulated statistics are printed as a summary at the end of the run.
  const keypoolStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    rotations: 0,
    exhaustions: 0,
    keysUsed: new Set<string>(),
  }

  // Infer KeypoolEvent type from Agent constructor to avoid a direct import from @sctg/cline-shared.
  type AgentKeypoolEvent = NonNullable<Parameters<typeof Agent>[0]> extends { keypoolEventHandler?: (e: infer E) => void } ? E : never

  function handleKeypoolEvent(event: AgentKeypoolEvent): void {
    switch (event.type) {
      case "user-agent-set":
        process.stderr.write(
          `[Keypool] User-Agent: ${event.userAgent} (source: ${event.source})\n`,
        )
        break
      case "key-selected":
        process.stderr.write(
          `[Keypool] Key selected: ${event.keyHint}` +
          (event.keyOwner ? ` (${event.keyOwner})` : "") +
          ` — ${event.providerName}/${event.modelId}\n`,
        )
        keypoolStats.keysUsed.add(event.keyHint)
        break
      case "key-rotated":
        keypoolStats.rotations++
        process.stderr.write(
          `[Keypool] Rotating from ${event.failedKeyHint}` +
          ` (attempt ${event.attempt + 1}): ${event.error.slice(0, 120)}\n`,
        )
        break
      case "key-exhausted":
        keypoolStats.exhaustions++
        process.stderr.write(
          `[Keypool] All ${event.attempts} rotation attempts exhausted` +
          ` for ${event.providerName}/${event.modelId}\n`,
        )
        break
      case "key-recovered":
        if (verbose) {
          process.stderr.write(`[Keypool] Key healthy: ${event.keyHint}\n`)
        }
        break
      case "usage-recorded":
        keypoolStats.totalInputTokens += event.inputTokens
        keypoolStats.totalOutputTokens += event.outputTokens
        keypoolStats.totalCacheReadTokens += event.cacheReadTokens
        keypoolStats.totalCacheWriteTokens += event.cacheWriteTokens
        keypoolStats.keysUsed.add(event.keyHint)
        if (verbose) {
          process.stderr.write(
            `[Keypool] Usage: in=${event.inputTokens} out=${event.outputTokens}` +
            (event.cacheReadTokens ? ` cacheRead=${event.cacheReadTokens}` : "") +
            ` via ${event.keyHint}` +
            (event.keyOwner ? ` (${event.keyOwner})` : "") + "\n",
          )
        }
        break
    }
  }

  // --- Agent instantiation ---
  const agent = new Agent({
    providerId: config.models.provider,
    modelId: config.models.fast,
    apiKey: resolveApiKey(config),
    systemPrompt: SYSTEM_PROMPT,
    tools: allTools,
    maxIterations: config.sync.maxIterations,
    // Prevent the run from ending until generate_report (completesRun: true) is called.
    completionPolicy: { requireCompletionTool: true },
    // Wire keypoollive event callbacks to get visibility into key rotation and usage.
    ...(config.models.provider === "keypoollive" ? { keypoolEventHandler: handleKeypoolEvent } : {}),
  })

  return {
    agent,
    userInstructionService,
    keypoolStats
  }
}