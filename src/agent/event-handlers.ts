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
 * @file event-handlers.ts
 *
 * Event handlers for the Backport Agent.
 * Handles agent event subscription and output streaming.
 */
import type { Agent } from "@sctg/cline-sdk"

interface EventHandlersParams {
  verbose: boolean
}

interface EventHandlersResult {
  subscribeToAgent: (agent: Agent) => void
  getLastSeenIteration: () => number
  /** Returns maxIterationFromPreviousRuns + lastSeenIteration (the effective displayed iteration). */
  getLastDisplayedIteration: () => number
  resetIterationTracking: () => void
  updateMaxIterationFromPreviousRuns: (value: number) => void
  updateCurrentAttempt: (value: number) => void
}

export function setupEventHandlers(params: EventHandlersParams): EventHandlersResult {
  const { verbose } = params

  // --- Shared iteration state ---
  // Track iterations across retry attempts: when restarting after an error,
  // display should show the max iteration seen before the retry (not cumulative).
  // lastOutput tracks the last stream that wrote a partial line (no trailing \n)
  // so we can insert a newline before switching streams.
  let lastOutput: "text" | "reasoning" | "none" = "none"
  let maxIterationFromPreviousRuns = 0
  let lastSeenIteration = 0
  let currentAttempt = 1

  // Subscribe a fresh Agent instance to the shared streaming handlers.
  // Called once per retry attempt since each attempt creates a new Agent.
  function subscribeToAgent(agent: Agent): void {
    agent.subscribe((event: Parameters<Parameters<typeof agent.subscribe>[0]>[0]) => {
      const rawIter = (event as unknown as { iteration?: number }).iteration
      if (typeof rawIter === "number" && rawIter > lastSeenIteration) {
        lastSeenIteration = rawIter
      }
      const displayIter = typeof rawIter === "number" ? maxIterationFromPreviousRuns + rawIter : "?"

      if (event.type === "assistant-text-delta") {
        // Ensure we start on a fresh line when switching from reasoning output
        if (lastOutput === "reasoning") process.stderr.write("\n")
        lastOutput = "text"
        process.stdout.write(event.text)

      } else if (event.type === "assistant-reasoning-delta" && verbose) {
        // Show model thinking in verbose mode; prefix the first delta of each block
        if (lastOutput === "text") process.stderr.write("\n")
        if (lastOutput !== "reasoning") process.stderr.write("[thinking] ")
        lastOutput = "reasoning"
        // Strip redacted reasoning (null/empty)
        const text = (event as unknown as { text?: string; redacted?: boolean }).text
        const redacted = (event as unknown as { redacted?: boolean }).redacted
        if (!redacted && text) process.stderr.write(text)

      } else if (event.type === "tool-started") {
        // Always emit a newline when leaving a streaming block, then show the tool.
        if (lastOutput === "text" || lastOutput === "reasoning") process.stderr.write("\n")
        lastOutput = "none"
        const inp = event.toolCall.input as Record<string, unknown>
        // Keys that hold large file content — skip in previews to keep output readable.
        const CONTENT_KEYS = new Set(["baseContent", "resolvedContent", "forkVersion", "upstreamVersion", "withMarkers", "content", "fileContent"])
        if (verbose) {
          // Detailed format: show meaningful input keys, skip large content blobs.
          const meaningfulKeys = inp && typeof inp === "object"
            ? Object.keys(inp).filter((k) => !CONTENT_KEYS.has(k))
            : []
          const preview =
            meaningfulKeys.length > 0
              ? meaningfulKeys
                  .slice(0, 3)
                  .map((k) => `${k}=${JSON.stringify(inp[k]).slice(0, 80)}`)
                  .join(", ")
              : Object.keys(inp ?? {}).length > 0
                ? "(content omitted)"
                : "(no input)"
          process.stderr.write(`[→ iter ${displayIter}] ${event.toolCall.toolName}(${preview})\n`)
        } else {
          // Compact format: tool name + first meaningful key as hint so progress is visible
          const meaningfulKeys = inp && typeof inp === "object"
            ? Object.keys(inp).filter((k) => !CONTENT_KEYS.has(k))
            : []
          const firstKey = meaningfulKeys[0] ?? (inp && typeof inp === "object" ? Object.keys(inp)[0] : undefined)
          const hint = firstKey !== undefined ? ` ${JSON.stringify(inp[firstKey]).slice(0, 60)}` : ""
          process.stderr.write(`[→] ${event.toolCall.toolName}${hint}\n`)
        }

      } else if (event.type === "tool-finished" && verbose) {
        lastOutput = "none"
        const result = event.toolCall as unknown as { toolName: string }
        process.stderr.write(`[← iter ${displayIter}] ${result.toolName ?? event.toolCall.toolName} done\n`)

      } else if (event.type === "iteration_start" || event.type === "turn-started") {
        const retrySuffix = currentAttempt > 1 ? ` - Retry ${currentAttempt - 1}` : ""
        if (verbose) {
          process.stderr.write(`\n--- iteration ${displayIter}${retrySuffix} ---\n`)
        } else {
          // Even without verbose, show turn boundaries so progress is visible
          process.stderr.write(`\n[turn ${displayIter}${retrySuffix}]\n`)
        }
        lastOutput = "none"
      }
    })
  }

  return {
    subscribeToAgent,
    getLastSeenIteration: () => lastSeenIteration,
    getLastDisplayedIteration: () => maxIterationFromPreviousRuns + lastSeenIteration,
    resetIterationTracking: () => {
      currentAttempt = 1
      lastSeenIteration = 0
      maxIterationFromPreviousRuns = 0
    },
    updateMaxIterationFromPreviousRuns: (value: number) => {
      maxIterationFromPreviousRuns = value
      // Reset the raw-iter tracker so the next run can accumulate from 1.
      // Without this, SDK iters 1, 2, ... from the resumed run would be < the
      // previous max (e.g. 14) and lastSeenIteration would never update.
      lastSeenIteration = 0
    },
    updateCurrentAttempt: (value: number) => {
      currentAttempt = value
    },
  }
}

export type EventHandlers = ReturnType<typeof setupEventHandlers>