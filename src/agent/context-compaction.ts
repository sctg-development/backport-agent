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
 * @file agent/context-compaction.ts
 *
 * Automatic context compaction for the Backport Agent.
 *
 * When the agent's conversation history approaches the model's context limit,
 * the `prepareTurn` hook in agent-setup.ts calls `compactConversation()` here.
 * A large-context summarizer model (e.g. Gemini 2.5 Flash, 1M tokens) distils
 * the full transcript into a compact progress summary, resetting the in-context
 * history to ~15k tokens so the run can continue processing remaining commits.
 *
 * The summarizer returns structured JSON:
 *   { progressSummary, commitResults, blockedCommits, currentStep }
 *
 * These fields are injected back as synthetic assistant context before the
 * last few messages (recency window), giving the main model enough context to
 * resume where it left off without any awareness that compaction occurred.
 */

import { randomUUID } from "node:crypto"
import { Agent } from "@sctg/cline-sdk"
import type { AgentMessage, AgentMessagePart } from "@sctg/cline-agents"
import type { SyncConfig } from "../config/schema.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CompactionSummary {
  progressSummary: string
  commitResults: unknown[]
  blockedCommits: unknown[]
  currentStep: string
}

interface SummarizerConfig {
  providerId: string
  modelId: string
  apiKey: string | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Construct a minimal but valid AgentMessage for injecting synthetic context.
 */
function makeTextMessage(role: "user" | "assistant", text: string): AgentMessage {
  return {
    id: randomUUID(),
    role,
    content: [{ type: "text", text }],
    createdAt: Date.now(),
  }
}

/**
 * Serialise an AgentMessage array into a human-readable conversation transcript.
 * This is what the summarizer receives to understand the full run history.
 *
 * - user / assistant roles: render text and reasoning parts; tool-call and
 *   tool-result parts are summarised as one-liners to avoid inflating the
 *   serialised size with large JSON outputs.
 * - tool role: render as [TOOL RESULT] one-liner.
 */
export function serializeMessages(messages: readonly AgentMessage[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    const roleLabel = msg.role === "user" ? "[USER]" : msg.role === "assistant" ? "[ASSISTANT]" : "[TOOL]"

    for (const part of msg.content) {
      switch (part.type) {
        case "text":
          lines.push(`${roleLabel}: ${part.text}`)
          break
        case "reasoning":
          lines.push(`${roleLabel} [REASONING]: ${part.text}`)
          break
        case "tool-call": {
          const inputStr = typeof part.input === "string" ? part.input : JSON.stringify(part.input)
          // Truncate large inputs so the transcript stays manageable.
          const truncated = inputStr.length > 500 ? inputStr.slice(0, 500) + "…" : inputStr
          lines.push(`${roleLabel} [TOOL CALL: ${part.toolName}]: ${truncated}`)
          break
        }
        case "tool-result": {
          const outputStr = typeof part.output === "string" ? part.output : JSON.stringify(part.output)
          const truncated = outputStr.length > 800 ? outputStr.slice(0, 800) + "…" : outputStr
          lines.push(`${roleLabel} [TOOL RESULT: ${part.toolName}]: ${truncated}`)
          break
        }
        default:
          // image / file / unknown parts: skip silently
          break
      }
    }
  }

  return lines.join("\n\n")
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the provider/model/key to use for compaction.
 * Falls back to `models.specialist` with the same provider if `models.summarizer` is absent.
 */
export function getSummarizerConfig(config: SyncConfig): SummarizerConfig {
  if (config.models.summarizer) {
    const { provider, modelId, apiKey } = config.models.summarizer
    // If apiKey is an env-var reference (starts with "$"), resolve it.
    const resolvedKey = apiKey?.startsWith("$") ? process.env[apiKey.slice(1)] : apiKey
    return { providerId: provider, modelId, apiKey: resolvedKey }
  }
  // Fallback: use specialist model with the same provider and API key as the main agent.
  // Note: the main API key is accessed via config; provider.ts resolution happens upstream.
  const fallbackKey = config.models.apiKey === "auto"
    ? undefined
    : config.models.apiKey?.startsWith("$")
      ? process.env[config.models.apiKey.slice(1)]
      : config.models.apiKey
  return {
    providerId: config.models.provider,
    modelId: config.models.specialist,
    apiKey: fallbackKey,
  }
}

/**
 * Compact the agent's conversation history using a large-context summarizer model.
 *
 * @param messages    - Current conversation messages from `prepareTurn`.
 * @param systemPrompt - The agent's system prompt (preserved verbatim in output).
 * @param config      - Validated SyncConfig (for summarizer model resolution).
 * @param providerId  - Resolved provider ID for the summarizer.
 * @param apiKey      - Resolved API key for the summarizer.
 * @returns Compacted messages array, or `null` on any failure (triggering soft/hard fallbacks).
 */
export async function compactConversation(
  messages: readonly AgentMessage[],
  _systemPrompt: string,
  config: SyncConfig,
  providerId: string,
  apiKey: string | undefined,
): Promise<readonly AgentMessage[] | null> {
  const { modelId } = getSummarizerConfig(config)

  // Need at least a few messages for compaction to be worthwhile.
  if (messages.length < 4) return null

  // Identify the original task (first user message) — preserved verbatim.
  const firstUserMsg = messages.find((m) => m.role === "user")
  const originalTask = firstUserMsg
    ? firstUserMsg.content
        .filter((p: AgentMessagePart) => p.type === "text")
        .map((p: AgentMessagePart) => (p as { type: "text"; text: string }).text)
        .join("\n")
    : "(original task unavailable)"

  // Keep the last few messages verbatim as a recency window so the model knows
  // exactly what step it was on when compaction fired.
  // Expand backwards until every tool-result in the window has its matching
  // tool-call also in the window (orphaned results cause provider errors).
  const RECENT_WINDOW = 6
  let windowStart = Math.max(0, messages.length - RECENT_WINDOW)

  type PartWithCallId = AgentMessagePart & { toolCallId: string }
  while (windowStart > 0) {
    const window = messages.slice(windowStart)
    const presentCallIds = new Set(
      window
        .flatMap((m) => m.content)
        .filter((p): p is PartWithCallId => p.type === "tool-call" && "toolCallId" in p)
        .map((p) => p.toolCallId),
    )
    const hasOrphan = window.some((m) =>
      m.content.some(
        (p: AgentMessagePart): p is PartWithCallId =>
          p.type === "tool-result" && "toolCallId" in p && !presentCallIds.has((p as PartWithCallId).toolCallId),
      ),
    )
    if (!hasOrphan) break
    windowStart--
  }

  const recentMessages = messages.slice(windowStart)

  // Serialize the full conversation for the summarizer.
  const transcript = serializeMessages(messages)

  const summarizerSystemPrompt = `You are summarizing the progress of an ongoing automated git backport-agent run.
Your output will be used to resume the run after its context was compacted.

You MUST return ONLY a JSON object with exactly these fields (no markdown, no explanation):
{
  "progressSummary": "<markdown summary of all work done>",
  "commitResults": [<complete array of all commit decisions>],
  "blockedCommits": [<complete array of blocked/deferred commits>],
  "currentStep": "<what the agent was about to do next>"
}

Rules:
- Preserve ALL commit SHAs exactly — they are needed to resume the run
- Each entry in commitResults must include: sha, subject, riskLevel, result (applied/skipped/conflict-blocked/validation-failed), and any reason
- Each entry in blockedCommits must include: sha, subject, reason
- currentStep must be actionable (e.g. "cherry-pick commit abc1234" or "call run_validation after applying 3 commits")
- progressSummary should be 3–8 bullet points covering what was accomplished`

  const userPrompt = `Here is the complete conversation transcript to summarize:\n\n${transcript}`

  try {
    const summarizer = new Agent({
      providerId,
      modelId,
      apiKey,
      systemPrompt: summarizerSystemPrompt,
      tools: [],
    })

    const result = await summarizer.run(userPrompt)

    if (result.status !== "completed" || !result.outputText) {
      process.stderr.write(`[Compaction] Summarizer ended with status "${result.status}" — skipping compaction\n`)
      return null
    }

    // Strip markdown code fences if the model wrapped JSON in them.
    const rawJson = result.outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")

    let summary: CompactionSummary
    try {
      summary = JSON.parse(rawJson) as CompactionSummary
    } catch {
      process.stderr.write(`[Compaction] Failed to parse summarizer JSON — skipping compaction\n`)
      return null
    }

    // Validate the required fields exist.
    if (typeof summary.progressSummary !== "string" || !Array.isArray(summary.commitResults)) {
      process.stderr.write(`[Compaction] Summarizer returned incomplete JSON — skipping compaction\n`)
      return null
    }

    // Build the compacted messages array:
    // 1. Original task (user)
    // 2. Compact progress summary (assistant)
    // 3. Last 6 messages verbatim (recency window)
    const summaryContent = [
      "=== CONTEXT COMPACTED ===",
      "",
      summary.progressSummary,
      "",
      `**commitResults (${summary.commitResults.length} entries):**`,
      "```json",
      JSON.stringify(summary.commitResults, null, 2),
      "```",
      "",
      `**blockedCommits (${summary.blockedCommits.length} entries):**`,
      "```json",
      JSON.stringify(summary.blockedCommits, null, 2),
      "```",
      "",
      `**Current step:** ${summary.currentStep}`,
      "",
      "Resume from this step. The conversation history above has been summarised to free context space.",
    ].join("\n")

    const compacted: AgentMessage[] = [
      makeTextMessage("user", originalTask),
      makeTextMessage("assistant", summaryContent),
      ...recentMessages,
    ]

    return compacted
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[Compaction] Summarizer error: ${msg.slice(0, 200)} — skipping compaction\n`)
    return null
  }
}
