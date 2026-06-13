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
 * @file ai/ai-tools.ts
 *
 * AI-powered agent tools that spawn focused sub-agents for tasks requiring
 * deep language model reasoning beyond what the deterministic rule engine
 * can provide.
 *
 * **Why sub-agents?**
 * The main backport agent drives the orchestration loop and calls deterministic
 * git/GitHub/validation tools.  Some decisions — conflict resolution, semantic
 * understanding of diffs, customisation compatibility — benefit from a dedicated
 * LLM call with a narrowly scoped system prompt and no distracting tool context.
 * Spawning a sub-`Agent` with `tools: []` gives exactly that: a single-turn
 * reasoning call that returns structured JSON.
 *
 * **Tools exported by `makeAiTools`:**
 *
 * 1. `resolve_conflict_with_ai` — Given a three-way conflict (base / ours /
 *    theirs), produce a resolved file body with no conflict markers.
 *    Uses `config.models.powerful` for maximum reasoning quality.
 *
 * 2. `analyze_commit_for_backport` — Given a commit SHA, message, diff, and
 *    changed-file list, produce a structured semantic assessment of what the
 *    commit does and how risky it is to backport.
 *    Uses `config.models.fast` (analytical but not critical-path).
 *
 * 3. `check_customization_compatibility` — Given a diff and a list of
 *    customisation records (pattern + description), reason about whether the
 *    upstream changes could semantically break fork-specific behaviour even
 *    if no textual conflict exists.
 *    Uses `config.models.fast`.
 *
 * **JSON extraction:**
 * Sub-agents are instructed to emit only a JSON object.  In practice, some
 * models wrap the object in a markdown code fence.  `extractJson` strips the
 * fence when present so `JSON.parse` always receives clean text.
 *
 * **Error handling:**
 * If the sub-agent call fails (network error, model error, parse error), each
 * tool returns a structured fallback object with `error` set rather than
 * throwing, so the main agent can log the failure and continue.
 */

import { z } from "zod"
import { Agent } from "@sctg/cline-sdk"
import { defineTool } from "../tool-helper.js"
import type { SyncConfig } from "../config/schema.js"
import type { Customizations } from "../customizations/schema.js"
import { getCommitDiff } from "../git/git-client.js"
import { globSync } from "node:fs"
import { join as joinPath } from "node:path"
import { minimatch } from "minimatch"

// Timeout error detection regex - matches common timeout error messages
const TIMEOUT_ERROR_PATTERNS = [
  /body timeout/i,
  /request timeout/i,
  /socket timeout/i,
  /ETIMEDOUT/i,
  /ESOCKETTIMEDOUT/i,
  /ECONNABORTED/i,
  /deadline exceeded/i,
  /response timeout/i,
  /read timeout/i,
  /connect timeout/i,
  /timed out/i,
  /timeout error/i,
  /timeout after/i,
  /timeout: /i,
  / timed out/i,
  / timeout /i,
]

/**
 * Checks if an error message indicates a timeout error
 * @param errorMessage - The error message to check
 * @returns true if the error is a timeout error, false otherwise
 */
function isTimeoutError(errorMessage: string): boolean {
  return TIMEOUT_ERROR_PATTERNS.some(pattern => pattern.test(errorMessage))
}

/**
 * Logs a timeout error with enhanced verbosity
 * @param logPath - Path to the JSONL log file
 * @param toolName - Name of the tool that timed out
 * @param errorMessage - The timeout error message
 * @param context - Additional context about what was being processed
 */
function logTimeoutError(logPath: string, toolName: string, errorMessage: string, context: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const errorRecord = {
    type: "timeout_error",
    timestamp,
    tool: toolName,
    error: errorMessage,
    ...context
  }

  // Log to stderr with high visibility
  process.stderr.write(`\n[TIMEOUT ERROR] ${timestamp} - ${toolName}\n`)
  process.stderr.write(`[TIMEOUT ERROR] Error: ${errorMessage}\n`)
  if (context.sha) {
    process.stderr.write(`[TIMEOUT ERROR] Commit SHA: ${context.sha}\n`)
  }
  if (context.commitMessage) {
    const shortMessage = typeof context.commitMessage === 'string' ? context.commitMessage.slice(0, 100) : ''
    process.stderr.write(`[TIMEOUT ERROR] Commit: ${shortMessage}${shortMessage.length === 100 ? '...' : ''}\n`)
  }
  if (context.durationMs) {
    process.stderr.write(`[TIMEOUT ERROR] Duration: ${context.durationMs}ms\n`)
  }
  process.stderr.write(`[TIMEOUT ERROR] Tool: ${toolName}\n`)
  process.stderr.write('[TIMEOUT ERROR] See prompt log for full details\n')

  // Also log to the JSONL file for audit trail
  try {
    appendFileSync(logPath, JSON.stringify(errorRecord) + "\n", "utf8")
  } catch {
    process.stderr.write(`[TimeoutLogger] Warning: could not write timeout error to ${logPath}\n`)
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for AI tool output validation (Improvement 1)
// ---------------------------------------------------------------------------

/**
 * Expected shape of `resolve_conflict_with_ai` model output.
 * Validated at runtime so schema mismatches surface immediately instead of
 * silently propagating wrong types through the agent loop.
 */
const ConflictResolutionOutputSchema = z.object({
  resolvedContent: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
})
export { ConflictResolutionOutputSchema }

/** Expected shape of `analyze_commit_for_backport` model output. */
const AnalyzeCommitOutputSchema = z.object({
  summary: z.string().max(500),
  keyChanges: z.array(z.string().max(150)).max(5),
  backportComplexity: z.enum(["trivial", "moderate", "complex"]),
  semanticRiskFactors: z.array(z.string().max(200)).max(3),
  recommendation: z.enum(["apply", "apply-with-care", "review-required", "skip"]),
})
export { AnalyzeCommitOutputSchema }

/** Expected shape of `check_customization_compatibility` model output. */
const CheckCompatibilityOutputSchema = z.object({
  compatible: z.boolean(),
  affectedCustomizations: z.array(z.string().max(100)).max(5),
  semanticConflicts: z.array(z.string().max(200)).max(3),
  warnings: z.array(z.string().max(200)).max(3),
  recommendation: z.string().max(300),
})
export { CheckCompatibilityOutputSchema }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to extract a JSON value from raw LLM output.
 *
 * The LLM may wrap its JSON in a markdown code fence (```` ```json … ``` ````
 * or ```` ``` … ``` ````).  This helper strips the fences when present so
 * `JSON.parse` receives valid JSON text.
 *
 * @typeParam T - Expected shape of the parsed value.
 * @param text - Raw string output from the sub-agent.
 * @returns The parsed value cast to `T`.
 * @throws `SyntaxError` if no valid JSON can be found in the text.
 */
export function extractJson<T>(text: string): T {
  // 1. Try ```json … ``` code fence (most common for structured output)
  const jsonFenceMatch = text.match(/```json\s*([\s\S]*?)```/)
  if (jsonFenceMatch) {
    return JSON.parse(jsonFenceMatch[1].trim()) as T
  }

  // 2. Try generic ``` … ``` code fence
  const genericFenceMatch = text.match(/```\s*([\s\S]*?)```/)
  if (genericFenceMatch) {
    return JSON.parse(genericFenceMatch[1].trim()) as T
  }

  // 3. Try to find an inline JSON object `{…}` in the text
  const inlineObjectMatch = text.match(/\{[\s\S]*\}/)
  if (inlineObjectMatch) {
    return JSON.parse(inlineObjectMatch[0]) as T
  }

  // 4. Last resort: parse the full trimmed text
  return JSON.parse(text.trim()) as T
}

// ---------------------------------------------------------------------------
// PromptLogger — records all sub-agent LLM interactions to a JSONL file
// ---------------------------------------------------------------------------

import { appendFileSync, readFileSync } from "node:fs"

/**
 * Token usage breakdown from a single sub-agent LLM call.
 */
interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalCost?: number
}

/**
 * Appends a single prompt/response record to the run's JSONL log file.
 *
 * The log file path is `./run-<timestamp>.prompts.jsonl` (relative to cwd).
 * It is created on first write and appended on subsequent calls.
 * Each line is a self-contained JSON object — suitable for streaming analysis
 * and incremental loading without parsing the entire file.
 *
 * @param logPath    - Absolute path to the JSONL log file for this run.
 * @param toolName   - The backport agent tool that invoked the sub-agent.
 * @param modelId    - LLM model identifier used for this call.
 * @param prompt     - Full user prompt sent to the sub-agent.
 * @param response   - Raw text response received from the sub-agent.
 * @param durationMs - Wall-clock time for the sub-agent call in milliseconds.
 * @param error      - Optional error message if the call failed.
 * @param usage      - Optional token usage breakdown from the LLM response.
 */
function logPrompt(
  logPath: string,
  toolName: string,
  modelId: string,
  prompt: string,
  response: string,
  durationMs: number,
  error?: string | null,
  usage?: TokenUsage | null,
  extra?: Record<string, unknown>,
): void {
  const record = {
    timestamp: new Date().toISOString(),
    tool: toolName,
    model: modelId,
    durationMs,
    prompt,
    response,
    ...(error ? { error } : {}),
    ...(usage ? {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      ...(usage.totalCost != null ? { totalCost: usage.totalCost } : {}),
    } : {}),
    ...(extra ?? {}),
  }
  try {
    appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8")
  } catch {
    // Log write failures are non-fatal — the agent run must not be blocked.
    process.stderr.write(`[PromptLogger] Warning: could not write to ${logPath}\n`)
  }
}

// ---------------------------------------------------------------------------
// Audit event logger — independent trail not relying on LLM self-reporting
// (Improvement 9)
// ---------------------------------------------------------------------------

/**
 * Appends a structured audit event to the run's JSONL log.
 *
 * Audit events are distinguished from prompt entries by the `"type": "audit_event"`
 * field.  They are written unconditionally at the tool layer so the run audit
 * trail cannot be silently omitted by the orchestrator LLM.
 *
 * @param logPath - JSONL log file path for the current run.
 * @param tool    - Tool name that produced this event.
 * @param event   - Short machine-readable event name (e.g. `"conflict_markers_detected"`).
 * @param details - Optional structured key-value details.
 */
function logAuditEvent(
  logPath: string,
  tool: string,
  event: string,
  details?: Record<string, unknown>,
): void {
  const record = {
    type: "audit_event" as const,
    timestamp: new Date().toISOString(),
    tool,
    event,
    ...(details ? { details } : {}),
  }
  try {
    appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8")
  } catch {
    process.stderr.write(`[AuditLog] Warning: could not write audit event to ${logPath}\n`)
  }
}

// ---------------------------------------------------------------------------
// Syntax balance checker for TypeScript / JavaScript files (Improvement 6)
// ---------------------------------------------------------------------------

const SYNTAX_CHECK_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"])

/**
 * Checks that braces, parentheses, and brackets are balanced in `content`.
 * Only runs for TypeScript/JavaScript files (identified by `filePath` extension).
 *
 * Uses a simplified stripping pass (line comments, block comments, string literals)
 * before counting delimiters.  Designed to catch the most common AI mistakes
 * (truncated output, incomplete code blocks) rather than be a full parser.
 *
 * @returns `{ valid: true }` when balanced, or `{ valid: false, issue }` otherwise.
 */
export function checkSyntaxBalance(
  content: string,
  filePath: string,
): { valid: boolean; issue?: string } {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  if (!SYNTAX_CHECK_EXTENSIONS.has(ext)) return { valid: true }

  // Strip line comments, block comments, and string/template literals.
  // Template literals are stripped as opaque strings (simplified — does not
  // handle nested template expressions, which is fine for this use-case).
  const stripped = content
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")

  let braces = 0, parens = 0, brackets = 0
  for (const ch of stripped) {
    if (ch === "{") braces++
    else if (ch === "}") { if (--braces < 0) return { valid: false, issue: "Unexpected '}'" } }
    else if (ch === "(") parens++
    else if (ch === ")") { if (--parens < 0) return { valid: false, issue: "Unexpected ')'" } }
    else if (ch === "[") brackets++
    else if (ch === "]") { if (--brackets < 0) return { valid: false, issue: "Unexpected ']'" } }
  }
  if (braces !== 0) return { valid: false, issue: `Unbalanced braces (${braces > 0 ? "unclosed '{'" : "extra '}'"})` }
  if (parens !== 0) return { valid: false, issue: `Unbalanced parentheses (${parens > 0 ? "unclosed '('" : "extra ')'"})` }
  if (brackets !== 0) return { valid: false, issue: `Unbalanced brackets (${brackets > 0 ? "unclosed '['" : "extra ']'"})` }
  return { valid: true }
}

// ---------------------------------------------------------------------------
// Dice-coefficient line similarity — used for consensus comparison (Improvement 5)
// ---------------------------------------------------------------------------

/**
 * Computes the Dice coefficient of two strings compared at the trimmed-line level.
 *
 * A score of `1.0` means both strings share identical non-empty line sets.
 * A score of `0.0` means no lines in common.
 *
 * @returns Number in the range [0, 1].
 */
export function computeLineSimilarity(a: string, b: string): number {
  const linesA = new Set(a.split("\n").map((l) => l.trim()).filter(Boolean))
  const linesB = new Set(b.split("\n").map((l) => l.trim()).filter(Boolean))
  const common = [...linesA].filter((l) => linesB.has(l)).length
  const total = linesA.size + linesB.size
  return total === 0 ? 1 : (2 * common) / total
}

// ---------------------------------------------------------------------------
// Hallucination detector — cross-checks AI references against real files
// (Improvement 8)
// ---------------------------------------------------------------------------

/**
 * Scans free-text fragments for file-path-like references and returns those
 * that do not appear in `actualChangedFiles`.
 *
 * Detected suspects are appended to `semanticRiskFactors` by
 * `analyze_commit_for_backport` so the orchestrator and human reviewer are
 * aware of potentially hallucinated claims.
 *
 * @param textFragments     - Free-text strings (keyChanges, semanticRiskFactors…).
 * @param actualChangedFiles - Ground-truth list of files from `git diff-tree`.
 * @returns Array of suspected hallucinated file references.
 */
export function detectHallucinatedFileRefs(
  textFragments: string[],
  actualChangedFiles: string[],
): string[] {
  // Match file-path-like references including:
  //  - Root-level files with no slash: README.md, config.ts
  //  - Scoped packages: @scope/pkg/file.ts
  //  - Hyphenated paths: cline-sdk/src/index.ts
  // The original \b boundary is removed as it breaks on hyphens and @ prefixes.
  const FILE_REF_RE =
    /(@?(?:[\w.@-][\w.@/-]*\/)*[\w.@-][\w.@-]*\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|json|md|yaml|yml|py|go|rs|java|kt|cs|cpp|c|h|rb|php|swift|sh))/g

  const mentioned = new Set<string>()
  for (const text of textFragments) {
    for (const match of text.matchAll(FILE_REF_RE)) {
      mentioned.add(match[1] ?? match[0])
    }
  }

  return [...mentioned].filter(
    (ref) => !actualChangedFiles.some((cf) => cf === ref || cf.endsWith(`/${ref}`) || cf.includes(ref)),
  )
}

/**
 * Creates a minimal sub-`Agent` for a single-turn AI reasoning call.
 *
 * The sub-agent has an empty tools array — it performs a single reasoning turn
 * and returns its text output via `result.outputText`.
 *
 * @param modelId      - Model identifier to use (fast or powerful).
 * @param systemPrompt - System prompt that scopes the sub-agent's behaviour.
 * @param providerId   - LLM provider ID (e.g. `"anthropic"`, `"keypoollive"`).
 * @param apiKey       - Resolved API key (or `undefined` to let the SDK discover it).
 * @returns A configured `Agent` instance ready to call `.run(userPrompt)`.
 */
function makeSubAgent(
  modelId: string,
  systemPrompt: string,
  providerId: string,
  apiKey: string | undefined,
): Agent {
  return new Agent({
    providerId,
    modelId,
    apiKey,
    systemPrompt,
    tools: [],
  })
}

// ---------------------------------------------------------------------------
// Exported factory
// ---------------------------------------------------------------------------

/**
 * Builds and returns all AI-powered agent tools pre-bound to the provided config.
 *
 * @param config          - Validated `SyncConfig` loaded from `config.json`.
 * @param logPath         - Absolute path to the JSONL prompt log file for this run.
 *                          Created by `main.ts` as `run-<timestamp>.prompts.jsonl`.
 * @param providerId      - LLM provider ID resolved from `config.models.provider`.
 * @param apiKey          - Resolved API key (from config or env); `undefined` for SDK auto-discovery.
 * @param customizations  - Loaded customizations manifest; used to enrich conflict resolution
 *                          prompts with fork-specific context when the caller provides IDs.
 * @returns Array of four agent tools for AI-assisted analysis.
 */
export function makeAiTools(
  config: SyncConfig,
  logPath: string,
  providerId: string,
  apiKey: string | undefined,
  customizations?: Customizations,
) {
  // -------------------------------------------------------------------------
  // Tool 1: resolve_conflict_with_ai
  // -------------------------------------------------------------------------

  /**
   * Tool: resolve_conflict_with_ai
   *
   * Spawns a focused sub-agent to produce a conflict-free merged version of a
   * file that has a three-way merge conflict.
   *
   * The sub-agent receives the base (common ancestor), our (fork) version, and
   * their (upstream) version of the file, together with the upstream commit
   * message for context.  It reasons about the intent of each side and returns
   * a merged body with no conflict markers.
   *
   * Uses `config.models.powerful` because incorrect conflict resolution can
   * silently break fork-specific behaviour.
   */
  const resolveConflictTool = defineTool({
    name: "resolve_conflict_with_ai",
    description:
      "Resolves a three-way merge conflict in a single file using AI reasoning. " +
      "Provide the base (common ancestor), our (fork) version, and their (upstream) version " +
      "of the file, plus the upstream commit message for context. " +
      "Returns the resolved file content with no conflict markers, a confidence level, " +
      "and a brief reasoning summary. " +
      "Use this when cherry_pick_commit reports a conflict and you need to resolve a specific file.",
    inputSchema: z.object({
      /**
       * Repository-relative path to the conflicted file (e.g. `src/core/api/index.ts`).
       * Used only for display/reasoning context — no filesystem access is performed.
       */
      filePath: z.string().describe("Repo-relative path of the conflicted file"),

      /**
       * Content of the file at the common ancestor commit (merge base).
       * May be an empty string when the file was created on both branches independently.
       */
      baseContent: z.string().describe("File content at the common ancestor (merge base); empty string if none"),

      /**
       * Content of the file in the fork branch (our version, with our customisations).
       */
      ourContent: z.string().describe("File content in the fork branch (our customised version)"),

      /**
       * Content of the file in the upstream commit (their version).
       */
      theirContent: z.string().describe("File content from the upstream commit (their version)"),

      /**
       * The full commit message of the upstream change being cherry-picked.
       * Helps the model understand the intent of the upstream change.
       */
      commitMessage: z.string().describe("Upstream commit message, used to understand the intent of the change"),

      /**
       * Optional: a human-readable note describing relevant fork customisations
       * in this file (e.g. "This file contains the keypoollive provider registration").
       * When provided, the model uses it to decide which parts must not be overwritten.
       * If omitted but `affectedCustomizationIds` is supplied, the note is built
       * automatically from the customizations manifest.
       */
      customizationNote: z
        .string()
        .optional()
        .describe("Optional description of fork customisations in this file to help preserve them"),

      /**
       * IDs of `CustomizationEntry` objects (from `classify_commit_risk.customizationIds`)
       * that overlap with the file being resolved.  When provided and no explicit
       * `customizationNote` is given, the descriptions and invariants of these
       * entries are injected into the conflict resolution prompt automatically.
       */
      affectedCustomizationIds: z
        .array(z.string())
        .optional()
        .describe("Customization IDs from classify_commit_risk that overlap with this file"),
    }),
    execute: async ({ filePath, baseContent, ourContent, theirContent, commitMessage, customizationNote, affectedCustomizationIds }) => {
      /**
       * System prompt focuses the sub-agent exclusively on conflict resolution.
       * The model must output only a single JSON object.
       */
      const systemPrompt = [
        "You are an expert software engineer specialising in Git merge conflict resolution.",
        "Your sole task is to produce a clean merged version of a conflicted file.",
        "",
        "Rules:",
        "- Output ONLY a valid JSON object. No prose, no explanations outside the JSON.",
        '- The JSON must have exactly three fields: "resolvedContent", "confidence", "reasoning".',
        '- "resolvedContent": the complete resolved file content as a string. MUST contain zero conflict markers (<<<<<<<, =======, >>>>>>>).',
        '- "confidence": one of "high", "medium", or "low".',
        '  - "high": you are certain the resolution is correct and preserves all intent.',
        '  - "medium": the resolution is plausible but you had to make a judgment call.',
        '  - "low": the resolution is uncertain; a human should review it.',
        '- "reasoning": a single sentence explaining the key decision you made.',
        "",
        "Resolution strategy:",
        "1. Understand what the UPSTREAM change was trying to achieve (read the commit message).",
        "2. Understand what the FORK version preserves (customisations, local patches).",
        "3. Integrate both intents: keep fork customisations AND apply the upstream change where safe.",
        "4. When in doubt, prefer preserving fork customisations and mark confidence as 'low'.",
      ].join("\n")

      // Build the customization context section:
      // 1. Use the explicitly provided note if present.
      // 2. Otherwise auto-build from affectedCustomizationIds + loaded manifest.
      let resolvedCustomizationNote = customizationNote
      if (!resolvedCustomizationNote && affectedCustomizationIds?.length && customizations) {
        const entries = customizations.customizations.filter((c) =>
          affectedCustomizationIds.includes(c.id),
        )
        if (entries.length > 0) {
          resolvedCustomizationNote = entries
            .map((c) => {
              const invariantLine =
                c.invariants.length > 0 ? `\n  Invariants: ${c.invariants.join("; ")}` : ""
              return `• ${c.id}: ${c.description}${invariantLine}`
            })
            .join("\n")
        }
      }

      const customizationSection = resolvedCustomizationNote
        ? `\nFork customisation context:\n${resolvedCustomizationNote}\n`
        : ""

      const userPrompt =
        `Resolve the merge conflict in file: ${filePath}\n` +
        `Upstream commit message: ${commitMessage}\n` +
        customizationSection +
        `\n--- BASE (common ancestor) ---\n${baseContent || "(file did not exist at merge base)"}\n` +
        `\n--- OURS (fork version) ---\n${ourContent}\n` +
        `\n--- THEIRS (upstream version) ---\n${theirContent}\n` +
        `\nOutput the JSON object now.`

      // Try specialist model first; fall back to powerful on any failure.
      const modelsToTry = [
        { modelId: config.models.specialist, label: "specialist" },
        { modelId: config.models.powerful, label: "powerful" },
      ]

      // Regex for conflict markers — checked inside resolvedContent (Improvement 2).
      const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m

      let lastError: string | null = null
      for (const [idx, { modelId, label }] of modelsToTry.entries()) {
        // Brief pause before fallback attempts: if the first model failed due to a
        // rate-limit or transient error, hitting the second model immediately may
        // encounter the same condition.  A 2-second delay costs little latency but
        // substantially improves success rates under provider rate-pressure.
        if (idx > 0 && lastError !== null) {
          await new Promise((r) => setTimeout(r, 2_000))
        }
        try {
          const subAgent = makeSubAgent(modelId, systemPrompt, providerId, apiKey)
          const t0 = Date.now()
          const result = await subAgent.run(userPrompt)
          const durationMs = Date.now() - t0

          // --- Improvement 1: Zod schema validation ---
          const rawOutput = extractJson<unknown>(result.outputText ?? "")
          const validated = ConflictResolutionOutputSchema.safeParse(rawOutput)
          if (!validated.success) {
            const zodErr = validated.error.message
            logPrompt(logPath, "resolve_conflict_with_ai", modelId, userPrompt, result.outputText ?? "", durationMs, `Schema validation failed: ${zodErr}`)
            logAuditEvent(logPath, "resolve_conflict_with_ai", "schema_validation_failed", { modelId, label, error: zodErr })
            lastError = `Schema validation failed: ${zodErr}`
            process.stderr.write(
              `[resolve_conflict_with_ai] ${label} model (${modelId}) returned invalid schema: ${zodErr.slice(0, 120)} — ${
                label === "specialist" ? "retrying with powerful model" : "giving up"
              }\n`,
            )
            continue
          }
          const output = validated.data

          // --- Improvement 2: conflict marker guard ---
          const hasConflictMarkers = CONFLICT_MARKER_RE.test(output.resolvedContent)

          // --- Improvement 6: syntax balance check (TS/JS only) ---
          const syntaxCheck = checkSyntaxBalance(output.resolvedContent, filePath)

          // Effective confidence after guards.
          let effectiveConfidence = output.confidence
          const guards: string[] = []

          if (hasConflictMarkers) {
            effectiveConfidence = "low"
            guards.push("conflict_markers_detected")
            logAuditEvent(logPath, "resolve_conflict_with_ai", "conflict_markers_detected", { filePath, modelId })
            process.stderr.write(
              `[resolve_conflict_with_ai] GUARD: conflict markers in output for ${filePath} — downgrading confidence to low\n`,
            )
          }

          if (!syntaxCheck.valid) {
            effectiveConfidence = "low"
            guards.push(`syntax_issue:${syntaxCheck.issue}`)
            logAuditEvent(logPath, "resolve_conflict_with_ai", "syntax_validation_failed", {
              filePath,
              modelId,
              issue: syntaxCheck.issue,
            })
            process.stderr.write(
              `[resolve_conflict_with_ai] GUARD: syntax check failed for ${filePath}: ${syntaxCheck.issue} — downgrading confidence to low\n`,
            )
          }

          // --- Improvement 5: self-consistency consensus (opt-in) ---
          let consensusFailure = false
          if (config.ai.enableConflictConsensus && label === "specialist" && !hasConflictMarkers) {
            try {
              const consensusAgent = makeSubAgent(config.models.powerful, systemPrompt, providerId, apiKey)
              const ct0 = Date.now()
              const consensusResult = await consensusAgent.run(userPrompt)
              const consensusDurationMs = Date.now() - ct0
              const consensusValidated = ConflictResolutionOutputSchema.safeParse(
                extractJson<unknown>(consensusResult.outputText ?? ""),
              )
              if (consensusValidated.success) {
                const similarity = computeLineSimilarity(
                  output.resolvedContent,
                  consensusValidated.data.resolvedContent,
                )
                logPrompt(
                  logPath,
                  "resolve_conflict_with_ai:consensus",
                  config.models.powerful,
                  userPrompt,
                  consensusResult.outputText ?? "",
                  consensusDurationMs,
                  null,
                  consensusResult.usage,
                  { consensus: true, similarity },
                )
                if (similarity < config.ai.conflictConsensusThreshold) {
                  effectiveConfidence = "low"
                  consensusFailure = true
                  guards.push(`consensus_divergence:${similarity.toFixed(2)}`)
                  logAuditEvent(logPath, "resolve_conflict_with_ai", "consensus_divergence", {
                    filePath,
                    similarity,
                    threshold: config.ai.conflictConsensusThreshold,
                  })
                  process.stderr.write(
                    `[resolve_conflict_with_ai] CONSENSUS: models diverged (similarity=${similarity.toFixed(2)}, threshold=${config.ai.conflictConsensusThreshold}) for ${filePath} — downgrading to low\n`,
                  )
                } else {
                  logAuditEvent(logPath, "resolve_conflict_with_ai", "consensus_passed", { filePath, similarity })
                }
              }
            } catch (consensusErr) {
              const msg = consensusErr instanceof Error ? consensusErr.message : String(consensusErr)
              process.stderr.write(`[resolve_conflict_with_ai] Consensus check failed (non-fatal): ${msg}\n`)
            }
          }

          const reasoning =
            guards.length > 0 ? `[GUARD: ${guards.join(", ")}] ${output.reasoning}` : output.reasoning

          logPrompt(
            logPath,
            "resolve_conflict_with_ai",
            modelId,
            userPrompt,
            result.outputText ?? "",
            durationMs,
            null,
            result.usage,
            {
              originalConfidence: output.confidence,
              effectiveConfidence,
              hasConflictMarkers,
              syntaxValid: syntaxCheck.valid,
              consensusFailure,
              guards,
            },
          )
          logAuditEvent(logPath, "resolve_conflict_with_ai", "resolution_complete", {
            filePath,
            modelId,
            label,
            originalConfidence: output.confidence,
            effectiveConfidence,
            guards,
          })

          return {
            resolvedContent: output.resolvedContent,
            confidence: effectiveConfidence,
            reasoning,
            error: null,
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)

          // Check for timeout errors and log with enhanced verbosity
          if (isTimeoutError(lastError)) {
            logTimeoutError(logPath, "resolve_conflict_with_ai", lastError, {
              filePath,
              commitMessage,
              modelId,
              label,
              durationMs: 0 // We don't have the exact duration in catch block
            })
          }

          process.stderr.write(
            `[resolve_conflict_with_ai] ${label} model (${modelId}) failed: ${lastError.slice(0, 120)} — ${
              label === "specialist" ? "retrying with powerful model" : "giving up"
            }\n`,
          )
          logPrompt(logPath, "resolve_conflict_with_ai", modelId, userPrompt, "", 0, lastError)
        }
      }

      logAuditEvent(logPath, "resolve_conflict_with_ai", "resolution_failed", { filePath, error: lastError })
      return {
        resolvedContent: "",
        confidence: "low" as const,
        reasoning: `AI resolution failed on all models: ${lastError}`,
        error: lastError,
      }
    },
  })

  // -------------------------------------------------------------------------
  // Tool 2: analyze_commit_for_backport
  // -------------------------------------------------------------------------

  /**
   * Tool: analyze_commit_for_backport
   *
   * Spawns a sub-agent to produce a semantic assessment of an upstream commit
   * and its implications for the fork.
   *
   * Unlike the deterministic `classify_commit_risk` tool, this tool reasons
   * about the *intent* of the commit: what architectural or behavioural change
   * it introduces, whether it touches concepts relevant to the fork's
   * customisations, and what the recommended backport action is.
   *
   * Uses `config.models.fast` (analytical, not on the critical path).
   */
  const analyzeCommitTool = defineTool({
    name: "analyze_commit_for_backport",
    description:
      "Performs a semantic analysis of an upstream commit to understand its intent and " +
      "assess how complex it is to backport into the fork. " +
      "Returns a structured assessment with a human-readable summary, key changes, " +
      "complexity rating, semantic risk factors, and a backport recommendation. " +
      "Use this before cherry-picking a high-risk commit to better understand what it does.",
    inputSchema: z.object({
      /**
       * Full commit SHA (40-character hex string).
       */
      sha: z.string().describe("Full commit SHA"),

      /**
       * The commit's subject + body as returned by `git log --format=%B`.
       */
      commitMessage: z.string().describe("Full commit message (subject + body)"),

      /**
       * List of file paths changed by this commit (relative to repo root).
       * Available from `get_commit_details` without requesting the diff.
       */
      changedFiles: z.array(z.string()).describe("List of file paths changed by this commit"),
    }),
    execute: async ({ sha, commitMessage, changedFiles }) => {
      // Fetch the diff internally — keeps it out of the main orchestrator context.
      const diff = getCommitDiff(config.workingDir, sha)
      // Large diffs (e.g. bun.lock releases) get the powerful model for better reasoning
      // and a potentially different quota pool (fewer rate-limit issues).
      const analysisModel = diff.length > config.ai.largeContextThreshold
        ? config.models.powerful
        : config.models.fast
      // Build the fork customization context block once per tool factory (static).
      const forkContextLines: string[] =
        customizations?.customizations.length
          ? [
              "This fork has the following customization zones (files in these zones are fork-specific):",
              ...customizations.customizations.map(
                (c) => `  - ${c.id}: ${c.description} (paths: ${c.paths.join(", ")})`,
              ),
              "If this commit modifies files that fall inside these zones, flag it as high-risk.",
              "",
            ]
          : []

      const systemPrompt = [
        "You are an expert software engineer specialising in Git history analysis.",
        "Your task is to analyse a single upstream commit and assess how complex it is to",
        "backport it into a heavily customised fork.",
        "",
        ...forkContextLines,
        "CRITICAL: Be extremely concise. Your entire response must fit in 400 tokens or less.",
        "Output ONLY a valid JSON object with exactly these fields:",
        '  "summary":             string  — max 2 sentences, under 100 words.',
        '  "keyChanges":          string[] — at most 5 items, each under 20 words.',
        '  "backportComplexity":  "trivial" | "moderate" | "complex"',
        '    - "trivial":   small, isolated change with no side effects.',
        '    - "moderate":  meaningful change but scope is clear and contained.',
        '    - "complex":   refactor, API change, or broad change that may interact with customisations.',
        '  "semanticRiskFactors": string[] — at most 3 items, each under 30 words.',
        '                         (e.g. "renames exported interface", "changes provider registration pattern").',
        '                         Empty array if no risks detected.',
        '  "recommendation":      "apply" | "apply-with-care" | "review-required" | "skip"',
        '    - "apply":            safe to cherry-pick automatically.',
        '    - "apply-with-care":  cherry-pick but verify validation passes.',
        '    - "review-required":  human should review before merging.',
        '    - "skip":             commit should not be backported.',
      ].join("\n")

      const userPrompt =
        `Commit SHA: ${sha}\n` +
        `Commit message:\n${commitMessage}\n\n` +
        `Changed files (${changedFiles.length}):\n${changedFiles.join("\n")}\n\n` +
        `Diff:\n${diff}\n\n` +
        `Output the JSON object now.`

      try {
        const subAgent = makeSubAgent(analysisModel, systemPrompt, providerId, apiKey)
        const t0 = Date.now()
        const result = await subAgent.run(userPrompt)
        const durationMs = Date.now() - t0

        // Check for timeout errors and log with enhanced verbosity
        if (result.error) {
          const errorMessage = result.error instanceof Error ? result.error.message : String(result.error)
          if (isTimeoutError(errorMessage)) {
            logTimeoutError(logPath, "analyze_commit_for_backport", errorMessage, {
              sha,
              commitMessage,
              durationMs,
              model: analysisModel
            })
          }
        }

        // --- Improvement 1: Zod schema validation ---
        const rawOutput = extractJson<unknown>(result.outputText ?? "")
        const validated = AnalyzeCommitOutputSchema.safeParse(rawOutput)
        if (!validated.success) {
          throw new Error(`Schema validation failed: ${validated.error.message}`)
        }
        const output = validated.data

        // --- Improvement 8: hallucination detection ---
        const hallucinationSuspects = detectHallucinatedFileRefs(
          [...output.keyChanges, ...output.semanticRiskFactors],
          changedFiles,
        )
        if (hallucinationSuspects.length > 0) {
          output.semanticRiskFactors.push(
            `[AUDIT] ${hallucinationSuspects.length} possible hallucinated file reference(s) not found in diff: ${hallucinationSuspects.slice(0, 5).join(", ")}`,
          )
          logAuditEvent(logPath, "analyze_commit_for_backport", "hallucination_suspects", {
            sha,
            suspects: hallucinationSuspects,
          })
        }

        logPrompt(
          logPath,
          "analyze_commit_for_backport",
          analysisModel,
          userPrompt,
          result.outputText ?? "",
          durationMs,
          null,
          result.usage,
          {
            recommendation: output.recommendation,
            backportComplexity: output.backportComplexity,
            semanticRiskFactorsCount: output.semanticRiskFactors.length,
            hallucinationSuspectsCount: hallucinationSuspects.length,
          },
        )
        logAuditEvent(logPath, "analyze_commit_for_backport", "analysis_complete", {
          sha,
          recommendation: output.recommendation,
          complexity: output.backportComplexity,
          riskFactors: output.semanticRiskFactors.length,
          hallucinationSuspects: hallucinationSuspects.length,
        })

        return {
          summary: output.summary,
          keyChanges: output.keyChanges,
          backportComplexity: output.backportComplexity,
          semanticRiskFactors: output.semanticRiskFactors,
          recommendation: output.recommendation,
          error: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logPrompt(logPath, "analyze_commit_for_backport", analysisModel, userPrompt, "", 0, message)
        logAuditEvent(logPath, "analyze_commit_for_backport", "analysis_failed", { sha, error: message })
        return {
          summary: `Analysis failed: ${message}`,
          keyChanges: [],
          backportComplexity: "complex" as const,
          semanticRiskFactors: [`AI analysis unavailable: ${message}`],
          recommendation: "review-required" as const,
          error: message,
        }
      }
    },
  })

  // -------------------------------------------------------------------------
  // Tool 3: check_customization_compatibility
  // -------------------------------------------------------------------------

  /**
   * Tool: check_customization_compatibility
   *
   * Spawns a sub-agent to reason about whether an upstream diff is semantically
   * compatible with the fork's declared customisations.
   *
   * The deterministic `classify_commit_risk` tool matches file globs to flag
   * risky commits.  This tool goes further: it reads the *descriptions* of
   * customisations and asks the model whether the upstream change could break
   * the described behaviour, even if the changed files don't match the glob.
   *
   * Uses `config.models.fast` (fast reasoning, results used to augment the
   * main agent's risk assessment rather than as a hard gate).
   */
  const checkCompatibilityTool = defineTool({
    name: "check_customization_compatibility",
    description:
      "Checks whether an upstream diff is semantically compatible with the fork's customisations. " +
      "Goes beyond file-path glob matching: the AI reads the customisation descriptions and " +
      "reasons about whether the upstream change could break declared fork-specific behaviour. " +
      "Returns a compatibility verdict, a list of affected customisations, semantic conflicts, " +
      "warnings, and a recommendation. " +
      "Use this when classify_commit_risk returns 'medium' or 'high' and you want deeper insight.",
    inputSchema: z.object({
      /**
       * Full commit SHA — the diff is fetched internally to avoid duplicating it
       * in the main orchestrator context.
       */
      sha: z.string().describe("Full commit SHA to evaluate"),

      /**
       * List of customisation entries loaded from `customizations.yaml`.
       * Each entry has a glob pattern (identifying which files are customised)
       * and a human-readable description of what the customisation does.
       */
      customizations: z
        .array(
          z.object({
            /**
             * Glob pattern (e.g. `src/core/api/providers/**`) identifying files
             * that belong to this customisation zone.
             */
            pattern: z.string().describe("Glob pattern for customised file paths"),
            /**
             * Human-readable description of what this customisation does and why
             * it must be preserved.
             */
            description: z.string().describe("Description of the fork customisation"),
          }),
        )
        .describe("Customisation entries from customizations.yaml"),
    }),
    execute: async ({ sha, customizations }) => {
      // Fetch the diff internally — keeps it out of the main orchestrator context.
      const diff = getCommitDiff(config.workingDir, sha)
      // Route to powerful model for large diffs.
      const compatModel = diff.length > config.ai.largeContextThreshold
        ? config.models.powerful
        : config.models.fast

      /**
       * If there are no customisations defined, there is nothing to check.
       * Return a trivially compatible result without calling the LLM.
       */
      if (customizations.length === 0) {
        return {
          compatible: true,
          affectedCustomizations: [],
          semanticConflicts: [],
          warnings: [],
          recommendation: "No customisations defined; upstream change is safe to apply.",
          error: null,
        }
      }

      // --- Improvement 4: enrich each customization with actual file content ---
      const customizationList = (
        await Promise.all(
          customizations.map(async (c, i) => {
            let contentSnippet = ""
            if (config.ai.enrichCustomizationContext) {
              try {
                // globSync is available since Node.js v22 (required by engines field).
                const matchedPaths = globSync(c.pattern, { cwd: config.workingDir })
                  .filter(Boolean)
                  .slice(0, 2)
                const fileSnippets = matchedPaths
                  .filter((f) => f !== "")
                  .map((f) => {
                    const content = readFileSync(joinPath(config.workingDir, f), "utf8").slice(0, 2000)
                    return `[${f}]\n${content.split("\n").map((l) => "      " + l).join("\n")}`
                  })
                if (fileSnippets.length > 0) {
                  contentSnippet = `\n     Current file content (${fileSnippets.length} file(s)):\n      ${fileSnippets.join("\n      ---\n")}`
                }
              } catch {
                // Content enrichment is best-effort \u2014 never block a run.
              }
            }
            return `  ${i + 1}. Pattern: ${c.pattern}\n     Description: ${c.description}${contentSnippet}`
          }),
        )
      ).join("\n")

      const systemPrompt = [
        "You are an expert software engineer specialising in fork maintenance and semantic conflict detection.",
        "Your task is to assess whether an upstream Git diff could break the customised behaviour",
        "of a fork, given a list of declared customisations.",
        "",
        "CRITICAL: Be extremely concise. Your entire response must fit in 300 tokens or less.",
        "Output ONLY a valid JSON object with exactly these fields:",
        '  "compatible":             boolean — true if the upstream change is unlikely to break any customisation.',
        '  "affectedCustomizations": string[] — at most 5 items, each under 100 chars.',
        '  "semanticConflicts":      string[] — at most 3 items, each under 200 chars.',
        '                            Each entry is a concrete description (e.g. "renames ApiProvider enum',
        '                            value used by keypoollive provider registration").',
        '                            Empty array if no conflicts detected.',
        '  "warnings":               string[] — at most 3 items, each under 200 chars.',
        '                            Empty array if none.',
        '  "recommendation":         string — one sentence (under 300 chars) advising the agent what to do.',
        "",
        "Important: focus on SEMANTIC compatibility, not textual conflicts.",
        "A change can be textually clean but still break the fork (e.g. renaming an interface",
        "that the fork's custom provider implements).",
      ].join("\n")

      const userPrompt =
        `Declared fork customisations:\n${customizationList}\n\n` +
        `Upstream diff to evaluate:\n${diff}\n\n` +
        `Output the JSON object now.`

      try {
        const subAgent = makeSubAgent(compatModel, systemPrompt, providerId, apiKey)
        const t0 = Date.now()
        const result = await subAgent.run(userPrompt)
        const durationMs = Date.now() - t0

        // Check for timeout errors and log with enhanced verbosity
        if (result.error) {
          const errorMessage = result.error instanceof Error ? result.error.message : String(result.error)
          if (isTimeoutError(errorMessage)) {
            logTimeoutError(logPath, "check_customization_compatibility", errorMessage, {
              durationMs,
              model: compatModel,
              customizationCount: customizations.length
            })
          }
        }

        // --- Improvement 1: Zod schema validation ---
        const rawOutput = extractJson<unknown>(result.outputText ?? "")
        const validated = CheckCompatibilityOutputSchema.safeParse(rawOutput)
        if (!validated.success) {
          throw new Error(`Schema validation failed: ${validated.error.message}`)
        }
        const output = validated.data

        logPrompt(
          logPath,
          "check_customization_compatibility",
          compatModel,
          userPrompt,
          result.outputText ?? "",
          durationMs,
          null,
          result.usage,
          {
            compatible: output.compatible,
            affectedCount: output.affectedCustomizations.length,
            semanticConflictsCount: output.semanticConflicts.length,
            fileContentEnriched: config.ai.enrichCustomizationContext,
          },
        )
        logAuditEvent(logPath, "check_customization_compatibility", "compatibility_check_complete", {
          compatible: output.compatible,
          affectedCustomizations: output.affectedCustomizations,
          semanticConflictsCount: output.semanticConflicts.length,
          fileContentEnriched: config.ai.enrichCustomizationContext,
        })

        return {
          compatible: output.compatible,
          affectedCustomizations: output.affectedCustomizations,
          semanticConflicts: output.semanticConflicts,
          warnings: output.warnings,
          recommendation: output.recommendation,
          error: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logPrompt(logPath, "check_customization_compatibility", config.models.fast, userPrompt, "", 0, message)
        logAuditEvent(logPath, "check_customization_compatibility", "compatibility_check_failed", { error: message })
        return {
          compatible: false,
          affectedCustomizations: [],
          semanticConflicts: [],
          warnings: [`AI compatibility check failed: ${message}`],
          recommendation: "Treat as potentially incompatible; request human review.",
          error: message,
        }
      }
    },
  })

  // -------------------------------------------------------------------------
  // Tool 4: reconcile_ai_assessments  (Improvements 3 + 10)
  // -------------------------------------------------------------------------

  /**
   * Tool: reconcile_ai_assessments
   *
   * Deterministic (no LLM) reconciliation of `analyze_commit_for_backport` and
   * `check_customization_compatibility` outputs.
   *
   * Detects contradictions between the two AI assessments and always resolves
   * ambiguity conservatively (more-restrictive recommendation wins).  When
   * `config.ai.requireReviewOnSemanticRisk` is enabled, commits with semantic
   * risk factors are escalated to "review-required" regardless of the individual
   * AI recommendations.
   *
   * Calling this tool after both analysis tools have run produces a single,
   * audited final recommendation the orchestrator can act on directly.
   */
  const reconcileAssessmentsTool = defineTool({
    name: "reconcile_ai_assessments",
    description:
      "Reconciles potentially contradictory outputs from analyze_commit_for_backport and " +
      "check_customization_compatibility into a single audited recommendation. " +
      "Detects contradictions and always takes the more conservative path. " +
      "No AI call is made \u2014 this is a fast deterministic step. " +
      "Call this after both analyze_commit_for_backport and check_customization_compatibility " +
      "have been invoked for the same commit.",
    inputSchema: z.object({
      /** Commit SHA being reconciled (for audit logging). */
      sha: z.string().describe("Commit SHA being evaluated"),
      /** `recommendation` from `analyze_commit_for_backport`. */
      analyzeRecommendation: z
        .enum(["apply", "apply-with-care", "review-required", "skip"])
        .describe("Recommendation from analyze_commit_for_backport"),
      /** `semanticRiskFactors` from `analyze_commit_for_backport`. */
      analyzeSemanticRiskFactors: z
        .array(z.string())
        .describe("Semantic risk factors from analyze_commit_for_backport"),
      /** `compatible` field from `check_customization_compatibility`. */
      compatibilityCompatible: z
        .boolean()
        .describe("compatible field from check_customization_compatibility"),
      /** `semanticConflicts` from `check_customization_compatibility`. */
      compatibilitySemanticConflicts: z
        .array(z.string())
        .describe("semanticConflicts array from check_customization_compatibility"),
      /** `recommendation` from `check_customization_compatibility`. */
      compatibilityRecommendation: z
        .string()
        .describe("recommendation field from check_customization_compatibility"),
    }),
    execute: async ({
      sha,
      analyzeRecommendation,
      analyzeSemanticRiskFactors,
      compatibilityCompatible,
      compatibilitySemanticConflicts,
      compatibilityRecommendation,
    }) => {
      // Severity scale: lower = more permissive.
      const SEVERITY: Record<string, number> = {
        apply: 0,
        "apply-with-care": 1,
        "review-required": 2,
        skip: 3,
      }
      const TO_REC = ["apply", "apply-with-care", "review-required", "skip"] as const

      const analyzeSev = SEVERITY[analyzeRecommendation] ?? 2
      // If check_compatibility says not compatible, treat as at-least "review-required".
      const compatSev = compatibilityCompatible ? 0 : 2

      // Merge the two severity scores according to config.ai.reconciliationMode.
      let finalSev: number
      const mode = config.ai.reconciliationMode ?? "conservative"
      if (mode === "conservative") {
        // Default: always take the more restrictive recommendation.
        finalSev = Math.max(analyzeSev, compatSev)
      } else if (mode === "optimistic") {
        // Take the more permissive recommendation (faster throughput, less safe).
        finalSev = Math.min(analyzeSev, compatSev)
      } else {
        // Weighted blend: round the weighted average to the nearest severity level.
        const w = config.ai.analyzeWeight ?? 0.5
        finalSev = Math.round(w * analyzeSev + (1 - w) * compatSev)
        finalSev = Math.max(0, Math.min(3, finalSev))
      }

      // Apply config.ai.requireReviewOnSemanticRisk (Improvement 10).
      if (config.ai.requireReviewOnSemanticRisk && analyzeSemanticRiskFactors.length > 0) {
        finalSev = Math.max(finalSev, 2) // at least "review-required"
      }

      const finalRecommendation = TO_REC[Math.min(finalSev, 3)] ?? "review-required"

      // Contradiction: analyze said "apply"/"apply-with-care" but check_compatibility found issues.
      const contradictionDetected = analyzeSev < 2 && !compatibilityCompatible

      const reasons: string[] = []
      if (contradictionDetected) {
        reasons.push(
          `Contradiction: analyze_commit recommended \u201c${analyzeRecommendation}\u201d ` +
            `but check_customization_compatibility found compatibility issues`,
        )
      }
      if (compatibilitySemanticConflicts.length > 0) {
        reasons.push(`Semantic conflicts: ${compatibilitySemanticConflicts.slice(0, 3).join("; ")}`)
      }
      if (analyzeSemanticRiskFactors.length > 0) {
        reasons.push(`Risk factors: ${analyzeSemanticRiskFactors.slice(0, 3).join("; ")}`)
      }
      if (config.ai.requireReviewOnSemanticRisk && analyzeSemanticRiskFactors.length > 0 && finalSev >= 2) {
        reasons.push(`Escalated: requireReviewOnSemanticRisk=true with ${analyzeSemanticRiskFactors.length} risk factor(s)`)
      }

      logAuditEvent(logPath, "reconcile_ai_assessments", contradictionDetected ? "contradiction_detected" : "no_contradiction", {
        sha,
        analyzeRecommendation,
        compatibilityCompatible,
        finalRecommendation,
        compatibilityRecommendation,
      })

      return {
        finalRecommendation,
        contradictionDetected,
        unifiedReasoning:
          reasons.join(" | ") || `Both AI tools agree: proceed with \u201c${finalRecommendation}\u201d`,
      }
    },
  })

  // Return all four tools in a single array for spreading into the main Agent.
  return [resolveConflictTool, analyzeCommitTool, checkCompatibilityTool, reconcileAssessmentsTool]
}
