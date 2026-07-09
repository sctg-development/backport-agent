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
 * @file agent/run-state.ts
 *
 * Host-side mutable run state shared across tool factories.
 *
 * The agent loop is driven by an LLM whose behaviour is guided — but not
 * guaranteed — by the system prompt.  For unattended (cron) operation, the
 * safety rules that matter must be enforced in host code, not in prose.
 * This module is the single source of truth those host-side gates read
 * and write:
 *
 *  - `resolve_conflict_with_ai` records the *effective* confidence of every
 *    AI resolution, keyed by file path.
 *  - `apply_resolved_file` refuses to write a resolution whose recorded
 *    confidence is below `config.ai.minAutoApplyConfidence` (this is what
 *    finally wires that config option into runtime behaviour).
 *  - `run_validation` records whether any suite failed.
 *  - `auto_merge_pr` refuses to merge when validation failed or never ran.
 *  - `generate_report` reconciles the model-provided summary against this
 *    state (a failed validation can never be reported as a clean run) and
 *    stores the final outcome.
 *  - `main.ts` maps the outcome to a process exit code so a cron wrapper can
 *    distinguish "clean sync" (0) from "sync needs human attention" (2) and
 *    "fatal error" (1).
 */

/** Confidence levels orderable via CONFIDENCE_RANK. */
export type ResolutionConfidence = "high" | "medium" | "low"

/** Numeric ordering of confidence levels: higher is more confident. */
export const CONFIDENCE_RANK: Record<ResolutionConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
}

/** Record of one AI conflict resolution, kept per file path. */
export type ResolutionRecord = {
  /** Effective confidence after all host-side guards (markers, syntax, consensus). */
  confidence: ResolutionConfidence
  /** Guard identifiers that fired for this resolution (empty when clean). */
  guards: string[]
}

/** Result of one validation suite invocation. */
export type ValidationRecord = {
  /** Risk level / suite that ran ("low" | "medium" | "high" | "final"). */
  level: string
  /** Whether every command in the suite succeeded. */
  allPassed: boolean
}

/** Final outcome captured by `generate_report` for `main.ts` exit-code mapping. */
export type ReportOutcome = {
  allPassed: boolean
  needsHumanReview: boolean
  blockedCount: number
  unaccountedCount: number
}

/**
 * Mutable state for a single agent run.  One instance is created per run in
 * `setupAgent` and threaded into every tool factory that participates in a
 * host-side gate.
 */
export type RunState = {
  /** Effective confidence of the latest AI resolution, keyed by repo-relative file path. */
  resolutions: Map<string, ResolutionRecord>
  /** All validation suite invocations, in order. */
  validations: ValidationRecord[]
  /** Human-readable log of host-side gate activations (surfaced in the report). */
  gateEvents: string[]
  /** Outcome recorded by `generate_report`, or `null` if the run never got there. */
  reportOutcome: ReportOutcome | null
}

/** Creates a fresh, empty run state. */
export function createRunState(): RunState {
  return {
    resolutions: new Map(),
    validations: [],
    gateEvents: [],
    reportOutcome: null,
  }
}

/** `true` if at least one validation suite ran and failed during this run. */
export function validationFailed(state: RunState): boolean {
  return state.validations.some((v) => !v.allPassed)
}

/** `true` if at least one validation suite ran during this run. */
export function validationRan(state: RunState): boolean {
  return state.validations.length > 0
}

/**
 * `true` if `confidence` satisfies the configured minimum for auto-apply.
 *
 * @param confidence - Effective confidence recorded for a resolution.
 * @param minimum    - `config.ai.minAutoApplyConfidence`.
 */
export function meetsConfidence(confidence: ResolutionConfidence, minimum: ResolutionConfidence): boolean {
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[minimum]
}

/**
 * Records a gate activation both in the run state and on stderr so it is
 * visible live and in the final report.
 */
export function recordGateEvent(state: RunState, message: string): void {
  state.gateEvents.push(message)
  process.stderr.write(`[HostGate] ${message}\n`)
}
