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

#!/usr/bin/env tsx
/**
 * @file tools/benchmark-replay.ts
 *
 * **Benchmark Replay** — Improvement 11
 *
 * Replays all AI sub-agent calls recorded in a `.prompts.jsonl` run log using
 * an alternative model, then produces a side-by-side comparison report that
 * shows how the new model's outputs differ from the original.
 *
 * This lets you compare two models (e.g. `mistral/devstral-latest` vs
 * `anthropic/claude-sonnet-4-5`) without running a full sync against a real
 * repository.  The JSONL log contains every prompt verbatim, so replays are
 * perfectly reproducible.
 *
 * **Usage:**
 *
 * ```bash
 * # Compare the last run log with a different model
 * npx tsx src/tools/benchmark-replay.ts \
 *   --log run-1780060224987.prompts.jsonl \
 *   --model anthropic/claude-sonnet-4-5 \
 *   --provider anthropic \
 *   --api-key $ANTHROPIC_API_KEY
 *
 * # Or pipe provider config from a config.json
 * npx tsx src/tools/benchmark-replay.ts \
 *   --log run-1780060224987.prompts.jsonl \
 *   --model anthropic/claude-sonnet-4-5 \
 *   --config ./config.json
 * ```
 *
 * The comparison report is written to stdout (redirect to a file as needed).
 * Set `VERBOSE=true` to also see per-call diffs on stderr.
 *
 * **Exit codes:**
 *  - `0` — Replay completed (some calls may have failed; check the report).
 *  - `1` — Fatal error (missing arguments, unreadable log file).
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { Agent } from "@sctg/cline-sdk"

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  logPath: string
  model: string
  provider: string
  apiKey: string | undefined
  configPath: string | undefined
} {
  const args = argv.slice(2)
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag)
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
  }

  const logPath = get("--log")
  const model = get("--model")
  const configPath = get("--config")

  if (!logPath) {
    process.stderr.write("Error: --log <path> is required\n")
    process.stderr.write(
      "Usage: npx tsx src/tools/benchmark-replay.ts --log <run.prompts.jsonl> --model <modelId> [--provider <id>] [--api-key <key>] [--config <config.json>]\n",
    )
    process.exit(1)
  }
  if (!model) {
    process.stderr.write("Error: --model <modelId> is required\n")
    process.exit(1)
  }

  // Resolve provider and API key from CLI flags or config file.
  let provider = get("--provider")
  let apiKey = get("--api-key")

  if (configPath) {
    try {
      const cfg = JSON.parse(readFileSync(resolvePath(configPath), "utf8")) as {
        models?: { provider?: string; apiKey?: string }
      }
      if (!provider) provider = cfg.models?.provider
      if (!apiKey && cfg.models?.apiKey && !cfg.models.apiKey.startsWith("$")) {
        apiKey = cfg.models.apiKey
      }
    } catch (e) {
      process.stderr.write(`Warning: could not read config file ${configPath}: ${e}\n`)
    }
  }

  if (!provider) {
    process.stderr.write("Error: --provider <id> is required (or provide --config with models.provider)\n")
    process.exit(1)
  }

  return { logPath: resolvePath(logPath), model, provider, apiKey, configPath }
}

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

interface PromptEntry {
  type?: string
  timestamp: string
  tool: string
  model: string
  durationMs: number
  prompt: string
  response: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  recommendation?: string
  effectiveConfidence?: string
}

function readPromptEntries(logPath: string): PromptEntry[] {
  if (!existsSync(logPath)) {
    process.stderr.write(`Error: log file not found: ${logPath}\n`)
    process.exit(1)
  }
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as PromptEntry
        // Skip audit events — only replay actual LLM prompts.
        if (parsed.type === "audit_event") return []
        // Skip consensus entries to avoid inflating replay cost.
        if (parsed.tool?.includes(":consensus")) return []
        return [parsed]
      } catch {
        return []
      }
    })
}

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

function computeLineSimilarity(a: string, b: string): number {
  const linesA = new Set(a.split("\n").map((l) => l.trim()).filter(Boolean))
  const linesB = new Set(b.split("\n").map((l) => l.trim()).filter(Boolean))
  const common = [...linesA].filter((l) => linesB.has(l)).length
  const total = linesA.size + linesB.size
  return total === 0 ? 1 : (2 * common) / total
}

function extractJson(text: string): unknown {
  const m1 = text.match(/```json\s*([\s\S]*?)```/)
  if (m1) return JSON.parse(m1[1].trim())
  const m2 = text.match(/```\s*([\s\S]*?)```/)
  if (m2) return JSON.parse(m2[1].trim())
  const m3 = text.match(/\{[\s\S]*\}/)
  if (m3) return JSON.parse(m3[0])
  return JSON.parse(text.trim())
}

// ---------------------------------------------------------------------------
// Replay logic
// ---------------------------------------------------------------------------

interface ReplayResult {
  callIndex: number
  tool: string
  originalModel: string
  replayModel: string
  originalResponse: string
  replayResponse: string
  originalDurationMs: number
  replayDurationMs: number
  similarity: number
  originalRecommendation?: string
  replayRecommendation?: string
  replayError?: string
}

async function replayCall(
  entry: PromptEntry,
  callIndex: number,
  replayModel: string,
  provider: string,
  apiKey: string | undefined,
): Promise<ReplayResult> {
  const replayAgent = new Agent({
    providerId: provider,
    modelId: replayModel,
    apiKey,
    systemPrompt: "",
    tools: [],
  })

  const t0 = Date.now()
  let replayResponse = ""
  let replayError: string | undefined

  try {
    const result = await replayAgent.run(entry.prompt)
    replayResponse = result.outputText ?? ""
  } catch (err) {
    replayError = err instanceof Error ? err.message : String(err)
  }
  const replayDurationMs = Date.now() - t0

  const similarity = replayError ? 0 : computeLineSimilarity(entry.response, replayResponse)

  // Try to extract recommendation/confidence from both responses for comparison.
  let originalRecommendation: string | undefined = entry.recommendation
  let replayRecommendation: string | undefined
  if (!replayError) {
    try {
      const parsed = extractJson(replayResponse) as Record<string, unknown>
      replayRecommendation =
        (parsed.recommendation as string) ??
        (parsed.confidence as string) ??
        (parsed.compatible != null ? String(parsed.compatible) : undefined)
      if (!originalRecommendation) {
        const orig = extractJson(entry.response) as Record<string, unknown>
        originalRecommendation =
          (orig.recommendation as string) ??
          (orig.confidence as string) ??
          (orig.compatible != null ? String(orig.compatible) : undefined)
      }
    } catch {
      // Non-JSON responses — comparison is similarity-only.
    }
  }

  return {
    callIndex,
    tool: entry.tool,
    originalModel: entry.model,
    replayModel,
    originalResponse: entry.response,
    replayResponse,
    originalDurationMs: entry.durationMs,
    replayDurationMs,
    similarity,
    originalRecommendation,
    replayRecommendation,
    replayError,
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function buildReport(
  logPath: string,
  replayModel: string,
  entries: PromptEntry[],
  results: ReplayResult[],
): string {
  const date = new Date().toISOString()
  const lines: string[] = [
    "# Backport Agent — Benchmark Replay Report",
    "",
    `**Date**: ${date}`,
    `**Source log**: \`${logPath}\``,
    `**Original calls**: ${entries.length}`,
    `**Replay model**: \`${replayModel}\``,
    "",
    "---",
    "",
    "## Summary",
    "",
  ]

  const succeeded = results.filter((r) => !r.replayError)
  const failed = results.filter((r) => r.replayError)
  const avgSim = succeeded.length > 0
    ? succeeded.reduce((s, r) => s + r.similarity, 0) / succeeded.length
    : 0
  const lowSimCount = succeeded.filter((r) => r.similarity < 0.5).length
  const decisionMismatches = succeeded.filter(
    (r) => r.originalRecommendation && r.replayRecommendation && r.originalRecommendation !== r.replayRecommendation,
  )

  lines.push(
    `| Metric | Value |`,
    `|---|---|`,
    `| Calls replayed | ${succeeded.length} / ${entries.length} |`,
    `| Replay errors | ${failed.length} |`,
    `| Average line similarity | ${(avgSim * 100).toFixed(1)} % |`,
    `| Low-similarity calls (< 50 %) | ${lowSimCount} |`,
    `| Decision mismatches | ${decisionMismatches.length} |`,
    "",
  )

  if (decisionMismatches.length > 0) {
    lines.push("### ⚠️ Decision Mismatches", "")
    for (const r of decisionMismatches) {
      lines.push(
        `- Call ${r.callIndex + 1} (\`${r.tool}\`): original=\`${r.originalRecommendation}\` → replay=\`${r.replayRecommendation}\``,
      )
    }
    lines.push("")
  }

  lines.push("---", "", "## Per-Call Comparison", "")

  for (const r of results) {
    const badge = r.replayError ? "❌" : r.similarity >= 0.7 ? "✅" : r.similarity >= 0.4 ? "⚠️" : "🔴"
    lines.push(
      `### Call ${r.callIndex + 1} \`${r.tool}\` ${badge}`,
      "",
      `| Field | Original | Replay |`,
      `|---|---|---|`,
      `| Model | \`${r.originalModel}\` | \`${r.replayModel}\` |`,
      `| Duration ms | ${r.originalDurationMs} | ${r.replayDurationMs} |`,
      ...(r.originalRecommendation || r.replayRecommendation
        ? [`| Decision | \`${r.originalRecommendation ?? "—"}\` | \`${r.replayRecommendation ?? "—"}\` |`]
        : []),
      ...(!r.replayError ? [`| Line similarity | — | ${(r.similarity * 100).toFixed(1)} % |`] : []),
      ...(r.replayError ? [`| Error | — | ${r.replayError} |`] : []),
      "",
    )
  }

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { logPath, model, provider, apiKey } = parseArgs(process.argv)

  const entries = readPromptEntries(logPath)
  if (entries.length === 0) {
    process.stderr.write("No prompt entries found in log file (only audit events or empty file).\n")
    process.exit(1)
  }

  const verbose = process.env.VERBOSE === "true"
  process.stderr.write(
    `[Replay] ${entries.length} call(s) to replay with model \`${model}\` via provider \`${provider}\`\n`,
  )

  const results: ReplayResult[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    process.stderr.write(`[Replay] ${i + 1}/${entries.length} \`${entry.tool}\` (${entry.model} → ${model})…\n`)
    const result = await replayCall(entry, i, model, provider, apiKey)
    results.push(result)
    if (verbose) {
      process.stderr.write(
        `[Replay] similarity=${(result.similarity * 100).toFixed(1)}%` +
          (result.replayError ? ` ERROR: ${result.replayError}` : "") +
          "\n",
      )
    }
  }

  const report = buildReport(logPath, model, entries, results)
  process.stdout.write(report + "\n")
}

main().catch((err) => {
  process.stderr.write(`[Replay] Fatal: ${err}\n`)
  process.exit(1)
})
