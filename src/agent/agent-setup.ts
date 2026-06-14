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
import type { AgentRuntimeHooks } from "@sctg/cline-agents"

type PrepareTurnContext = Parameters<NonNullable<AgentRuntimeHooks["prepareTurn"]>>[0]
import { loadCustomizations } from "../customizations/loader.js"
import { makeGitTools } from "../git/git-tools.js"
import { makeRiskTool } from "../risk/risk-tools.js"
import { makeValidationTool } from "../validation/validation-tools.js"
import { makeGitHubTools } from "../github/github-tools.js"
import { makeReportTool } from "../reports/report-tools.js"
import { makeAiTools } from "../ai/ai-tools.js"
import type { SyncConfig } from "../config/schema.js"
import { buildSystemPrompt } from "./system-prompt.js"
import { resolveApiKey } from "../config/provider.js"
import { compactConversation, getSummarizerConfig } from "./context-compaction.js"
import { Tiktoken } from "tiktoken/lite"
import cl100k_base from "tiktoken/encoders/cl100k_base.json" with { type: "json" }


interface AgentSetupParams {
  config: SyncConfig
  promptLogPath: string
  verbose: boolean
}

interface KeyUsage {
  event: string
  owner: string
  keyHint: string
  modelId: string
  usage?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

interface AgentSetupResult {
  /** Factory that creates a fresh Agent for each retry attempt. */
  agentFactory: () => Agent
  userInstructionService: Awaited<ReturnType<typeof createUserInstructionConfigService>>
  keypoolStats: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheWriteTokens: number
    rotations: number
    exhaustions: number
    keysUsed: Set<KeyUsage>
    /** Input token count of the most recent successful LLM call (0 before first call). */
    lastInputTokens: number
  }
}

/**
 * Estimate the number of tokens in a string using the cl100k_base encoding.
 * This is a fast approximation and may not be exact for all models.
 * @param text - The input string to estimate token count for.
 * @returns The estimated number of tokens in the input string.
 */
function estimateTokens(text: string): number {
  const encoding = new Tiktoken(cl100k_base.bpe_ranks,
    cl100k_base.special_tokens,
    cl100k_base.pat_str)
  const tokens = encoding.encode(text)
  encoding.free()
  return tokens.length
}

/**
 * Extract the API Key from the Authorization header
 * @param authorizationHeader - The Authorization header value
 * @returns The extracted API Key or null if not found
 */
function extractApiKeyFromAuthorizationHeader(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null

  const match = authorizationHeader.match(/Bearer\s+(\S+)/i)
  return match ? match[1] : null
}

/**
 * Mask the center of an API Key for logging purposes, showing only the first and last 6 characters.
 * @param apiKey - The API Key to mask
 * @returns The masked API Key
 */
function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return apiKey // Too short to mask effectively
  const start = apiKey.slice(0, 6)
  const end = apiKey.slice(-6)
  return `${start}...${end}`
}

/**
 * Wraps the global fetch to log raw HTTP status codes and error bodies.
 * Enabled by BACKPORT_HTTP_DEBUG=true (or "verbose" for 2xx logging too).
 *
 * Purpose: distinguish between a genuine Mistral HTTP 429 (which the keypool
 * SHOULD rotate on) and an error embedded in a 200 OK SSE stream (which the
 * keypool cannot detect). If "Rate limit exceeded" arrives via a 200 response
 * body, the keypool rotation will never fire — this wrapper reveals that case.
 * also print the Authorization header (with key hint) for each request to see which key was used.
 */
function installDebugFetch(): void {
  const level = process.env.BACKPORT_HTTP_DEBUG
  if (!level || level === "false") return

  const originalFetch = globalThis.fetch
  globalThis.fetch = async function debugFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input)
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    // Strip query params that may contain credentials before logging.
    const safeUrl = url.replace(/[?#].*$/, "")

    const response = await originalFetch(input, init)

    if (!response.ok) {
      // Non-2xx: always log status + first 400 chars of body.
      const body = await response.clone().text().catch(() => "(binary/unreadable)")
      process.stderr.write(
        `[HTTP] ← ${response.status} ${response.statusText} | ${method} ...${safeUrl.slice(-100)}\n` +
        `[HTTP]   ${body.slice(0, 400)}\n` + `[HTTP]   Authorization: ${maskApiKey(extractApiKeyFromAuthorizationHeader(init?.headers instanceof Headers ? init.headers.get("Authorization") : null) ?? "(none)")}\n`,
      )
    } else if (level === "verbose") {
      // Verbose mode: also log successful requests (no body, to avoid stream consumption).
      let authHeader: string | null = null
      let userAgent: string | null = null
      let modelName: string | null = null

      if (init?.headers instanceof Headers) {
        authHeader = init.headers.get("Authorization") || init.headers.get("authorization")
        userAgent = init.headers.get("User-Agent") || init.headers.get("user-agent")
      } else if (typeof init?.headers === 'object' && init.headers !== null) {
        const headers = init.headers as Record<string, string>
        authHeader = headers["Authorization"] || headers["authorization"] || null
        userAgent = headers["User-Agent"] || headers["user-agent"] || null
      }

      // Extract model from request body (OpenAI compatible format)
      try {
        if (init?.body) {
          const body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
          const bodyObj = typeof body === 'string' ? JSON.parse(body) : body
          if (bodyObj?.model) {
            modelName = bodyObj.model
          }
        }
      } catch (error) {
        // Silently fail if body parsing fails
        modelName = null
      }

      const tokenCount = init?.body ? estimateTokens(typeof init.body === 'string' ? init.body : JSON.stringify(init.body)) : 0

      const apiKey = extractApiKeyFromAuthorizationHeader(authHeader)
      const apiKeyDisplay = apiKey ? maskApiKey(apiKey) : "(none)"
      const userAgentDisplay = userAgent || "(none)"
      const modelDisplay = modelName || "(none)"

      process.stderr.write(
        `[HTTP] ← 200 ${response.statusText} | ${method} ...${safeUrl.slice(-100)}\n` +
        `[HTTP] API Key: ${apiKeyDisplay}\n` +
        `[HTTP] User-Agent: ${userAgentDisplay}\n` +
        `[HTTP] Model: ${modelDisplay}\n` +
        `[HTTP] Estimated tokens in request body: ${tokenCount}\n`
      )
    }

    return response
  }

  process.stderr.write(`[HTTP] Debug fetch wrapper active (BACKPORT_HTTP_DEBUG=${level})\n`)
}

export async function setupAgent(params: AgentSetupParams): Promise<AgentSetupResult> {
  const { config, promptLogPath, verbose } = params

  // Install HTTP debug wrapper early so it covers all requests made by the SDK.
  installDebugFetch()

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
  // Pass handleKeypoolEvent so sub-agents (ai-tools, report-tools) have their
  // token usage tracked in keypoolStats — otherwise only the main agent's calls
  // appear in the detailed key usage report.
  const keypoolHandler = config.models.provider === "keypoollive" ? handleKeypoolEvent : undefined
  const reportTool = makeReportTool(config, promptLogPath, config.models.provider, resolveApiKey(config), keypoolHandler) // 1 terminal tool (completesRun: true)
  const aiTools = makeAiTools(config, promptLogPath, config.models.provider, resolveApiKey(config), customizations, keypoolHandler) // 4 AI-powered analysis tools

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
      // Return JSON in the same shape as generate_report so main.ts can parse it uniformly.
      submit: async (summary: string, verified: boolean) =>
        JSON.stringify({ report: summary, allPassed: verified, needsHumanReview: !verified, agentState: {} }),
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
    keysUsed: new Set<KeyUsage>(),
    lastInputTokens: 0,
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
        keypoolStats.keysUsed.add({ event: event.type, owner: event.keyOwner ?? "(unknown)", keyHint: event.keyHint, modelId: event.modelId })
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
        keypoolStats.keysUsed.add({ event: event.type, owner: event.keyOwner ?? "(unknown)", keyHint: event.keyHint, modelId: event.modelId, usage: { input: event.inputTokens, output: event.outputTokens, cacheRead: event.cacheReadTokens, cacheWrite: event.cacheWriteTokens } })
        keypoolStats.lastInputTokens = event.inputTokens
        // Warn when the main orchestrator context approaches saturation.
        // This fires before the fatal error so the operator can act.
        if (event.inputTokens > 150_000) {
          process.stderr.write(
            `[Context] WARNING: ~${Math.round(event.inputTokens / 1000)}k tokens in context` +
            ` (model limit ~262k) — consider lowering maxCommitsPerRun\n`,
          )
        }
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

  // --- Agent factory ---
  // Returns a fresh Agent instance for each retry attempt so that conversation
  // history does not accumulate across retries (run() and continue() share the
  // same execute() in this SDK — a new instance guarantees a clean context).
  function agentFactory(): Agent {
    // Soft limit: inject a wrap-up message once when context approaches the model limit.
    const softLimit = config.sync.maxContextTokens
    // Hard limit: abort just before the API call would overflow the model's context window.
    // Capped at 260k to stay safely below devstral-medium-latest's 262k limit.
    const hardLimit = Math.min(Math.floor(softLimit * 1.15), 260_000)

    // Per-instance flag: only inject the wrap-up message once per agent run.
    let contextWrapupSent = false

    return new Agent({
      providerId: config.models.provider,
      modelId: config.models.fast,
      apiKey: resolveApiKey(config),
      systemPrompt: buildSystemPrompt((config.validation.final ?? []).length > 0),
      tools: allTools,
      maxIterations: config.sync.maxIterations,
      // Prevent the run from ending until generate_report (completesRun: true) is called.
      completionPolicy: { requireCompletionTool: true },
      // Wire keypoollive event callbacks to get visibility into key rotation and usage.
      ...(config.models.provider === "keypoollive" ? { keypoolEventHandler: handleKeypoolEvent } : {}),
      // Soft context guard: inject a one-time "wrap up NOW" user message when the previous
      // model call consumed more than softLimit tokens.  This gives the model a chance to
      // call generate_report gracefully before the hard abort fires.
      consumePendingUserMessage: () => {
        const tokens = keypoolStats.lastInputTokens
        if (tokens >= softLimit && !contextWrapupSent) {
          contextWrapupSent = true
          process.stderr.write(
            `[Context] Soft limit reached (~${Math.round(tokens / 1000)}k tokens), injecting wrap-up signal\n`,
          )
          return (
            `[CONTEXT BUDGET EXCEEDED — ~${Math.round(tokens / 1000)}k / ${Math.round(softLimit / 1000)}k tokens consumed]\n` +
            `MANDATORY: Stop processing commits immediately.\n` +
            `Add ALL commits not yet cherry-picked to blockedCommits with reason "context-limit: deferred to next run".\n` +
            `Call generate_report NOW with every commit processed so far.\n` +
            `This is an automated safeguard — the run will be hard-aborted if generate_report is not called within the next iteration.`
          )
        }
        return undefined
      },
      // Hard context guard: abort before the API call when the context has already grown past
      // the hard limit.  The abort reason matches CONTEXT_OVERFLOW_RE in retry-logic.ts so
      // it is treated as non-retriable (retrying would only recreate the same overflow).
      hooks: {
        beforeModel: async () => {
          const tokens = keypoolStats.lastInputTokens
          if (tokens >= hardLimit) {
            process.stderr.write(
              `[Context] Hard limit reached (~${Math.round(tokens / 1000)}k tokens ≥ ${Math.round(hardLimit / 1000)}k), aborting run to prevent context window overflow\n`,
            )
            return {
              stop: true,
              reason: `Context window limit reached: ~${Math.round(tokens / 1000)}k tokens exceeds the ${Math.round(hardLimit / 1000)}k hard limit — generate_report was not called in time, aborting run`,
            }
          }
          return undefined
        },
      },
      // Context compaction: when the conversation history exceeds compactionThreshold, use a
      // large-context summarizer model (e.g. Gemini 2.5 Flash, 1M tokens) to distil the
      // transcript into a compact progress summary.  The replacement persists permanently in
      // the in-memory transcript (unlike beforeModel which applies for one turn only), so the
      // agent continues processing remaining commits with a fresh ~15k context budget.
      prepareTurn: async ({ messages, systemPrompt }: PrepareTurnContext) => {
        const tokens = keypoolStats.lastInputTokens
        if (tokens < config.sync.compactionThreshold) return undefined

        const { providerId: sProvider, modelId: sModel, apiKey: sKey } = getSummarizerConfig(config)
        process.stderr.write(
          `[Context] Compacting ~${Math.round(tokens / 1000)}k tokens via ${sProvider}/${sModel}...\n`,
        )
        const compacted = await compactConversation(messages, systemPrompt ?? "", config, sProvider, sKey)
        if (!compacted) {
          process.stderr.write(`[Context] Compaction failed — soft/hard limits remain as fallback\n`)
          return undefined
        }
        process.stderr.write(`[Context] Compaction done: ${messages.length} → ${compacted.length} messages\n`)
        return { messages: compacted }
      },
    })
  }

  return {
    agentFactory,
    userInstructionService,
    keypoolStats
  }
}
