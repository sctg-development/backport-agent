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
function extractJson<T>(text: string): T {
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

import { appendFileSync } from "node:fs"

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
  }
  try {
    appendFileSync(logPath, JSON.stringify(record) + "\n", "utf8")
  } catch {
    // Log write failures are non-fatal — the agent run must not be blocked.
    process.stderr.write(`[PromptLogger] Warning: could not write to ${logPath}\n`)
  }
}

/**
 * Creates a minimal sub-`Agent` configured with the keypoollive provider.
 *
 * The sub-agent has an empty tools array — it performs a single reasoning turn
 * and returns its text output via `result.outputText`.
 *
 * @param modelId     - Model identifier to use (fast or powerful).
 * @param systemPrompt - System prompt that scopes the sub-agent's behaviour.
 * @returns A configured `Agent` instance ready to call `.run(userPrompt)`.
 */
function makeSubAgent(modelId: string, systemPrompt: string): Agent {
  return new Agent({
    providerId: "keypoollive",
    modelId,
    apiKey: "auto",
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
 * @param config  - Validated `SyncConfig` loaded from `config.json`.
 * @param logPath - Absolute path to the JSONL prompt log file for this run.
 *                  Created by `main.ts` as `run-<timestamp>.prompts.jsonl`.
 * @returns Array of three agent tools for AI-assisted analysis.
 */
export function makeAiTools(config: SyncConfig, logPath: string) {
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
       */
      customizationNote: z
        .string()
        .optional()
        .describe("Optional description of fork customisations in this file to help preserve them"),
    }),
    execute: async ({ filePath, baseContent, ourContent, theirContent, commitMessage, customizationNote }) => {
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

      const customizationSection = customizationNote
        ? `\nFork customisation context:\n${customizationNote}\n`
        : ""

      const userPrompt =
        `Resolve the merge conflict in file: ${filePath}\n` +
        `Upstream commit message: ${commitMessage}\n` +
        customizationSection +
        `\n--- BASE (common ancestor) ---\n${baseContent || "(file did not exist at merge base)"}\n` +
        `\n--- OURS (fork version) ---\n${ourContent}\n` +
        `\n--- THEIRS (upstream version) ---\n${theirContent}\n` +
        `\nOutput the JSON object now.`

      try {
        const subAgent = makeSubAgent(config.models.powerful, systemPrompt)
        const t0 = Date.now()
        const result = await subAgent.run(userPrompt)
        const durationMs = Date.now() - t0
        logPrompt(logPath, "resolve_conflict_with_ai", config.models.powerful, userPrompt, result.outputText ?? "", durationMs, null, result.usage)
        const output = extractJson<{
          resolvedContent: string
          confidence: "high" | "medium" | "low"
          reasoning: string
        }>(result.outputText ?? "")

        return {
          resolvedContent: output.resolvedContent,
          confidence: output.confidence,
          reasoning: output.reasoning,
          error: null,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logPrompt(logPath, "resolve_conflict_with_ai", config.models.powerful, userPrompt, "", 0, message)
        return {
          resolvedContent: "",
          confidence: "low" as const,
          reasoning: `AI resolution failed: ${message}`,
          error: message,
        }
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
       * Full unified diff of the commit as returned by `git show --format=` or
       * `git diff <parent> <sha>`.
       */
      diff: z.string().describe("Full unified diff of the commit"),

      /**
       * List of file paths changed by this commit (relative to repo root).
       */
      changedFiles: z.array(z.string()).describe("List of file paths changed by this commit"),
    }),
    execute: async ({ sha, commitMessage, diff, changedFiles }) => {
      const systemPrompt = [
        "You are an expert software engineer specialising in Git history analysis.",
        "Your task is to analyse a single upstream commit and assess how complex it is to",
        "backport it into a heavily customised fork.",
        "",
        "Output ONLY a valid JSON object with exactly these fields:",
        '  "summary":             string  — 2-3 sentence description of what this commit does.',
        '  "keyChanges":          string[] — bullet-point list of the most important code changes.',
        '  "backportComplexity":  "trivial" | "moderate" | "complex"',
        '    - "trivial":   small, isolated change with no side effects.',
        '    - "moderate":  meaningful change but scope is clear and contained.',
        '    - "complex":   refactor, API change, or broad change that may interact with customisations.',
        '  "semanticRiskFactors": string[] — list of reasons why this commit could break a fork',
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
        const subAgent = makeSubAgent(config.models.fast, systemPrompt)
        const t0 = Date.now()
        const result = await subAgent.run(userPrompt)
        const durationMs = Date.now() - t0
        logPrompt(logPath, "analyze_commit_for_backport", config.models.fast, userPrompt, result.outputText ?? "", durationMs, null, result.usage)
        const output = extractJson<{
          summary: string
          keyChanges: string[]
          backportComplexity: "trivial" | "moderate" | "complex"
          semanticRiskFactors: string[]
          recommendation: "apply" | "apply-with-care" | "review-required" | "skip"
        }>(result.outputText ?? "")

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
        logPrompt(logPath, "analyze_commit_for_backport", config.models.fast, userPrompt, "", 0, message)
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
       * Full unified diff of the upstream commit being evaluated.
       */
      diff: z.string().describe("Full unified diff of the upstream commit"),

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
    execute: async ({ diff, customizations }) => {
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

      const customizationList = customizations
        .map((c, i) => `  ${i + 1}. Pattern: ${c.pattern}\n     Description: ${c.description}`)
        .join("\n")

      const systemPrompt = [
        "You are an expert software engineer specialising in fork maintenance and semantic conflict detection.",
        "Your task is to assess whether an upstream Git diff could break the customised behaviour",
        "of a fork, given a list of declared customisations.",
        "",
        "Output ONLY a valid JSON object with exactly these fields:",
        '  "compatible":             boolean — true if the upstream change is unlikely to break any customisation.',
        '  "affectedCustomizations": string[] — names/patterns of customisations potentially affected.',
        '  "semanticConflicts":      string[] — specific ways the upstream change could break fork behaviour.',
        '                            Each entry is a concrete description (e.g. "renames ApiProvider enum',
        '                            value used by keypoollive provider registration").',
        '                            Empty array if no conflicts detected.',
        '  "warnings":               string[] — non-blocking concerns worth noting (e.g. "touches shared types',
        '                            used by customised components").',
        '                            Empty array if none.',
        '  "recommendation":         string — one sentence advising the agent what to do.',
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
        const subAgent = makeSubAgent(config.models.fast, systemPrompt)
        const t0 = Date.now()
        const result = await subAgent.run(userPrompt)
        const durationMs = Date.now() - t0
        logPrompt(logPath, "check_customization_compatibility", config.models.fast, userPrompt, result.outputText ?? "", durationMs, null, result.usage)
        const output = extractJson<{
          compatible: boolean
          affectedCustomizations: string[]
          semanticConflicts: string[]
          warnings: string[]
          recommendation: string
        }>(result.outputText ?? "")

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

  // Return all three tools in a single array for spreading into the main Agent.
  return [resolveConflictTool, analyzeCommitTool, checkCompatibilityTool]
}
