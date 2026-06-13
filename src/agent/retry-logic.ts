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
 * @file retry-logic.ts
 *
 * Retry logic for provider errors in the Backport Agent.
 * Handles exponential backoff and retry attempts for rate limits and timeouts.
 */
import type { Agent } from "@sctg/cline-sdk"

interface RetryLogicParams {
  agentFactory: () => Agent
  task: string
  eventHandlers: {
    subscribeToAgent: (agent: Agent) => void
    getLastSeenIteration: () => number
    getLastDisplayedIteration: () => number
    resetIterationTracking: () => void
    updateMaxIterationFromPreviousRuns: (value: number) => void
    updateCurrentAttempt: (value: number) => void
  }
  /** Returns the input token count of the last successful LLM call (0 before first call). */
  getLastInputTokens: () => number
}

export async function runWithRetry(params: RetryLogicParams): Promise<Awaited<ReturnType<typeof Agent.prototype.run>>> {
  const { agentFactory, task, eventHandlers, getLastInputTokens } = params

  const RETRIABLE_RE = /503|rate.?limit|too many requests|overloaded|service.?unavailable|high.?demand|try again later|temporarily unavailable|exceeded your current quota|quota.*exceeded|check your plan|billing details/i
  const TIMEOUT_RE = /timeout|timed out|body timeout|request timeout|socket timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|deadline exceeded|response timeout|read timeout|connect timeout/i
  // Context overflow errors must NOT be retried — retrying would only accumulate more history.
  const CONTEXT_OVERFLOW_RE = /too large for model|maximum context|context.?length|context.?window|token limit|exceeds.*context/i
  const BASE_DELAY_MS = 15_000
  const MAX_ATTEMPTS = 5

  // Message sent on transient-error retries. The agent sees its full conversation
  // history above this message and is explicitly told to resume rather than restart.
  // Re-injecting the original task would cause the model to restart from fetch_remotes,
  // discarding all work done before the interruption.
  const RESUME_MESSAGE =
    "A rate limit or temporary service error interrupted the previous attempt.\n" +
    "Your conversation history above shows all work completed so far.\n" +
    "IMPORTANT: Do NOT restart from fetch_remotes or list_candidate_commits.\n" +
    "Resume from exactly where you stopped — continue with the next pending step."

  // Writes a debug snapshot to the current working directory on retry.
  // Takes a context object so it can be called from both the throw-path (where
  // `result` is undefined) and the status-failed path (where `result` is set).
  async function writeDebugState(info: {
    attempt: number
    lastIteration: number
    lastInputTokens: number
    error: string
    result?: unknown
  }): Promise<void> {
    const fs = await import("fs/promises")
    const path = await import("path")
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const debugFile = path.join(process.cwd(), `agent-debug-${timestamp}.json`)
    await fs.writeFile(debugFile, JSON.stringify(info, null, 2), "utf-8")
    process.stderr.write(`[Retry] Debug state written to ${debugFile}\n`)
  }



  async function attempt(): Promise<Awaited<ReturnType<typeof Agent.prototype.run>>> {
    // currentAgent is kept alive across transient-error retries so the model can
    // resume its conversation from the last completed iteration. A fresh agent is
    // only created on the first attempt.
    let currentAgent: Agent | null = null

    for (let attemptNum = 1; attemptNum <= MAX_ATTEMPTS; attemptNum++) {
      eventHandlers.updateCurrentAttempt(attemptNum)

      // First attempt: fresh agent with the full task description.
      // Subsequent transient-error retries: reuse the same agent and send a resume
      // message so the model continues from its last iteration without restarting.
      let agent: Agent
      let message: string
      if (currentAgent === null) {
        agent = agentFactory()
        eventHandlers.subscribeToAgent(agent)
        currentAgent = agent
        message = task
      } else {
        agent = currentAgent
        message = RESUME_MESSAGE
      }

      let result: Awaited<ReturnType<typeof Agent.prototype.run>>
      try {
        result = await agent.run(message)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)

        // Context overflow is never retriable — it would only grow worse.
        if (CONTEXT_OVERFLOW_RE.test(msg)) {
          process.stderr.write(
            `[Retry] Context overflow on attempt ${attemptNum}/${MAX_ATTEMPTS}: ${msg.slice(0, 200)}\n` +
              `[Retry] This is not retriable. Lower maxCommitsPerRun or reduce diff sizes.\n`,
          )
          throw err
        }

        if (attemptNum < MAX_ATTEMPTS && (RETRIABLE_RE.test(msg) || TIMEOUT_RE.test(msg))) {
          const base = BASE_DELAY_MS * Math.pow(2, attemptNum - 1)
          const jitter = Math.floor(Math.random() * 0.3 * base)
          const delay = Math.min(base + jitter, 120_000)
          const errorType = TIMEOUT_RE.test(msg) ? "Timeout" : "Provider"
          const lastTokens = getLastInputTokens()

          process.stderr.write(
            `[Retry] ${errorType} error on attempt ${attemptNum}/${MAX_ATTEMPTS}: ${msg.slice(0, 120)}\n` +
              `[Retry] Last known context: ~${Math.round(lastTokens / 1000)}k tokens` +
              ` (iter ${eventHandlers.getLastDisplayedIteration()})\n` +
              `[Retry] Waiting ${Math.round(delay / 1000)}s before retrying (agent state preserved)...\n`,
          )
          writeDebugState({
            attempt: attemptNum,
            lastIteration: eventHandlers.getLastDisplayedIteration(),
            lastInputTokens: lastTokens,
            error: msg,
          }).catch((e: unknown) => {
            process.stderr.write(`[Retry] Failed to write debug state: ${e}\n`)
          })
          // The SDK resets its internal iteration counter to 1 with each run() call.
          // Update the display offset so resumed iterations continue from where they stopped.
          eventHandlers.updateMaxIterationFromPreviousRuns(eventHandlers.getLastDisplayedIteration())
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw err
      }

      // The SDK can return without throwing when the model API errors silently
      // (e.g. invalid model name, 503 absorbed internally). Treat non-completed
      // status as a throw so the retry loop can handle retriable cases.
      if (result.status !== "completed") {
        const err = result.error ?? new Error(`Agent run ended with status "${result.status}" (model API error?)`)
        const msg = err.message

        if (CONTEXT_OVERFLOW_RE.test(msg)) {
          process.stderr.write(
            `[Retry] Context overflow (status=${result.status}): ${msg.slice(0, 200)}\n` +
              `[Retry] This is not retriable. Lower maxCommitsPerRun or reduce diff sizes.\n`,
          )
          writeDebugState({
            attempt: attemptNum,
            lastIteration: eventHandlers.getLastDisplayedIteration(),
            lastInputTokens: getLastInputTokens(),
            error: msg,
            result,
          }).catch((e: unknown) => {
            process.stderr.write(`[Retry] Failed to write debug state: ${e}\n`)
          })
          throw err
        }

        if (attemptNum < MAX_ATTEMPTS && (RETRIABLE_RE.test(msg) || TIMEOUT_RE.test(msg))) {
          const base = BASE_DELAY_MS * Math.pow(2, attemptNum - 1)
          const jitter = Math.floor(Math.random() * 0.3 * base)
          const delay = Math.min(base + jitter, 120_000)
          const errorType = TIMEOUT_RE.test(msg) ? "Timeout" : "Provider"
          const lastTokens = getLastInputTokens()

          process.stderr.write(
            `[Retry] ${errorType} error (status=${result.status}) on attempt ${attemptNum}/${MAX_ATTEMPTS}: ${msg.slice(0, 120)}\n` +
              `[Retry] Last known context: ~${Math.round(lastTokens / 1000)}k tokens` +
              ` (iter ${eventHandlers.getLastDisplayedIteration()})\n` +
              `[Retry] Waiting ${Math.round(delay / 1000)}s before retrying (agent state preserved)...\n`,
          )
          writeDebugState({
            attempt: attemptNum,
            lastIteration: eventHandlers.getLastDisplayedIteration(),
            lastInputTokens: lastTokens,
            error: msg,
            result,
          }).catch((e: unknown) => {
            process.stderr.write(`[Retry] Failed to write debug state: ${e}\n`)
          })
          eventHandlers.updateMaxIterationFromPreviousRuns(eventHandlers.getLastDisplayedIteration())
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw err
      }

      eventHandlers.resetIterationTracking()
      return result
    }
    throw new Error("unreachable")
  }

  return attempt()
}
