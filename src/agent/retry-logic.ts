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
  agent: Agent
  task: string
  eventHandlers: {
    resetIterationTracking: () => void
    updateMaxIterationFromPreviousRuns: (value: number) => void
    updateCurrentAttempt: (value: number) => void
  }
  lastSeenIteration: number
}

export async function runWithRetry(params: RetryLogicParams): Promise<Awaited<ReturnType<typeof Agent.prototype.run>>> {
  const { agent, task, eventHandlers, lastSeenIteration } = params

  const RETRIABLE_RE = /503|rate.?limit|too many requests|overloaded|service.?unavailable|high.?demand|try again later|temporarily unavailable|exceeded your current quota|quota.*exceeded|check your plan|billing details/i
  const TIMEOUT_RE = /timeout|timed out|body timeout|request timeout|socket timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|deadline exceeded|response timeout|read timeout|connect timeout/i
  const BASE_DELAY_MS = 15_000
  const MAX_ATTEMPTS = 5

  async function runWithRetry(): Promise<Awaited<ReturnType<typeof Agent.prototype.run>>> {
    let consecutiveRateLimitErrors = 0
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      eventHandlers.updateCurrentAttempt(attempt)

      let result: Awaited<ReturnType<typeof Agent.prototype.run>>
      try {
        result = await agent.run(task)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (attempt < MAX_ATTEMPTS && (RETRIABLE_RE.test(msg) || TIMEOUT_RE.test(msg))) {
          if (RETRIABLE_RE.test(msg)) consecutiveRateLimitErrors++
          const delay = BASE_DELAY_MS * attempt
          const errorType = TIMEOUT_RE.test(msg) ? "Timeout" : "Provider"

          process.stderr.write(
            `[Retry] ${errorType} error on attempt ${attempt}/${MAX_ATTEMPTS}: ${msg.slice(0, 120)}\n` +
              `[Retry] Waiting ${delay / 1000}s before retrying...\n`,
          )
          eventHandlers.updateMaxIterationFromPreviousRuns(lastSeenIteration)
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
        if (attempt < MAX_ATTEMPTS && (RETRIABLE_RE.test(msg) || TIMEOUT_RE.test(msg))) {
          if (RETRIABLE_RE.test(msg)) consecutiveRateLimitErrors++
          const delay = BASE_DELAY_MS * attempt
          const errorType = TIMEOUT_RE.test(msg) ? "Timeout" : "Provider"

          process.stderr.write(
            `[Retry] ${errorType} error (status=${result.status}) on attempt ${attempt}/${MAX_ATTEMPTS}: ${msg.slice(0, 120)}\n` +
              `[Retry] Waiting ${delay / 1000}s before retrying...\n`,
          )
          eventHandlers.updateMaxIterationFromPreviousRuns(lastSeenIteration)
          await new Promise((r) => setTimeout(r, delay))
          continue
        }
        throw err
      }

      // Reset currentAttempt and lastSeenIteration after successful retry so subsequent iterations
      // don't show incorrect retry suffix and iteration offset is correct for next retry if needed
      eventHandlers.resetIterationTracking()
      return result
    }
    throw new Error("unreachable")
  }

  return runWithRetry()
}