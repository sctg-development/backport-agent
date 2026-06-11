/**
 * @file risk/classify-risk.ts
 *
 * Purely deterministic commit risk classifier — no LLM is involved.
 *
 * The classifier assigns one of three risk levels to an upstream commit:
 *  - **low**    — Only touches files that are safe to auto-apply.
 *  - **medium** — Touches shared infrastructure (API layer, shared types, services)
 *                  that may interact with fork customizations.
 *  - **high**   — Touches build configuration, CI pipelines, lockfiles, protobuf
 *                  definitions, or a file explicitly listed in the fork's
 *                  `customizations.yaml`.
 *
 * The LLM agent uses this output as high-level context before deciding whether
 * to attempt a cherry-pick, skip, or request human review.
 *
 * Pattern matching uses `minimatch` (the same glob library used by `.gitignore`
 * and the VS Code extension tree).  All patterns are relative to the repository
 * root, as returned by `git diff-tree --name-only`.
 */

import { minimatch } from "minimatch"
import type { Customizations } from "../customizations/schema.js"

/**
 * The three risk levels assigned to every upstream commit.
 *
 *  - `"low"`    Safe to cherry-pick with minimal validation.
 *  - `"medium"` Requires standard validation suite before merging.
 *  - `"high"`   Requires full validation + likely human review.
 */
export type RiskLevel = "low" | "medium" | "high"

/**
 * Full risk assessment result for a single upstream commit.
 */
export type CommitRisk = {
  /** The commit SHA that was classified. */
  sha: string
  /** Computed risk level: "low", "medium", or "high". */
  level: RiskLevel
  /** Human-readable explanations for why each risk factor was triggered. */
  reasons: string[]
  /** `true` if any file in the commit matches a customization zone in the fork. */
  touchesCustomization: boolean
  /** IDs of `CustomizationEntry` objects whose paths were matched by this commit. */
  customizationIds: string[]
  /**
   * Union of `testCommands` from all `CustomizationEntry` objects matched by this
   * commit.  The agent should pass these as `extraCommands` to `run_validation`
   * when validating a high-risk commit that touches customization zones.
   * Empty array when no customization defines `testCommands` or when risk is low/medium.
   */
  testCommands: string[]
}

/**
 * Glob patterns whose matches unconditionally elevate risk to `"high"`.
 *
 * These patterns are intentionally generic so the classifier works for any
 * repository layout (single-package, monorepo, multi-language, etc.).
 *
 *  - Root-level dependency manifests and lockfiles
 *  - CI / GitHub Actions / GitLab / CircleCI pipelines
 *  - Build scripts directory (scripts/**)
 *  - TypeScript project references (tsconfig*.json)
 *  - ESBuild config files (esbuild.*)
 *  - Protobuf/schema definitions anywhere in the tree (glob: ** /proto/**)
 *
 * Fork-specific paths (e.g. custom source directories, generated assets) should
 * be declared in `customizations.yaml` — the classifier always checks those first.
 */
const HIGH_RISK_PATTERNS = [
  // Root-level package manifests and lockfiles
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  // CI / CD pipelines
  ".github/workflows/**",
  ".gitlab-ci.yml",
  ".circleci/**",
  // Build tooling
  "scripts/**",
  "esbuild.*",
  "tsconfig*.json",
  // Schema/proto definitions (matches at any depth)
  "**/proto/**",
]

/**
 * Glob patterns whose matches elevate risk to `"medium"` when no high-risk
 * pattern has already been matched.
 *
 * These generic patterns capture shared infrastructure that commonly conflicts
 * with fork customizations across different project layouts (API layers,
 * shared types, services, and provider registries at any depth).
 */
const MEDIUM_RISK_PATTERNS = [
  "**/src/core/api/**",
  "**/src/shared/**",
  "**/src/services/**",
  "**/src/providers/**",
  "**/src/api/**",
]

/**
 * Classifies the risk level of an upstream commit based on which files it changes.
 *
 * Evaluation order (highest-priority first):
 *  1. Fork customization zones (`customizations.yaml`) → always `high`.
 *  2. `HIGH_RISK_PATTERNS` glob matches                → always `high`.
 *  3. `MEDIUM_RISK_PATTERNS` glob matches              → `medium` (if not already high).
 *  4. Detected file deletions or renames               → elevate to at least `medium`.
 *  5. No matches                                        → remains `low`.
 *
 * This function is **pure and deterministic** — given the same inputs it always
 * returns the same output.  It has no side effects and performs no I/O.
 *
 * @param sha             - Full or abbreviated commit SHA (used to label the result).
 * @param changedFiles    - Repository-relative file paths changed by the commit,
 *                          as returned by `getCommitChangedFiles`.
 * @param customizations  - Validated customizations manifest from `loadCustomizations`.
 * @returns A `CommitRisk` record with the computed level, reasons, and customization matches.
 */
export function classifyRisk(sha: string, changedFiles: string[], customizations: Customizations): CommitRisk {
  const reasons: string[] = []
  const matchedCustomizationIds: string[] = []
  const matchedTestCommands: string[] = []
  let level: RiskLevel = "low"

  // --- Step 1: Check fork customization zones ---
  // Any file that matches a customization's glob pattern triggers high risk,
  // because it means an upstream change directly conflicts with our fork-specific code.
  // Strip DELETE:/RENAME: prefixes before glob matching so patterns work correctly
  // regardless of how the file was changed; the prefix is only meaningful for step 4.
  for (const entry of customizations.customizations) {
    const hits = changedFiles.filter((f) =>
      entry.paths.some((p) => minimatch(f.replace(/^(?:DELETE:|RENAME:)/, ""), p)),
    )
    if (hits.length > 0) {
      matchedCustomizationIds.push(entry.id)
      reasons.push(`Touches customization "${entry.id}": ${hits.join(", ")}`)
      level = "high"
      // Collect per-customization test commands for later injection into run_validation.
      if (entry.testCommands) {
        matchedTestCommands.push(...entry.testCommands)
      }
    }
  }

  // --- Step 2: Check high-risk file patterns ---
  // Build infrastructure changes (lockfiles, CI, tsconfig, proto) are always high risk
  // regardless of whether they touch a named customization zone.
  for (const pattern of HIGH_RISK_PATTERNS) {
    const hits = changedFiles.filter((f) => minimatch(f.replace(/^(?:DELETE:|RENAME:)/, ""), pattern))
    if (hits.length > 0) {
      if (level !== "high") level = "high"
      reasons.push(`High-risk file pattern "${pattern}": ${hits.join(", ")}`)
    }
  }

  // --- Step 3: Check medium-risk patterns (only if still low) ---
  // These patterns are checked last so that a high-risk determination from steps 1-2
  // is not overwritten.  A medium classification means the agent should run the
  // standard validation suite but may still auto-apply.
  if (level === "low") {
    for (const pattern of MEDIUM_RISK_PATTERNS) {
      const hits = changedFiles.filter((f) => minimatch(f.replace(/^(?:DELETE:|RENAME:)/, ""), pattern))
      if (hits.length > 0) {
        level = "medium"
        reasons.push(`Medium-risk pattern "${pattern}": ${hits.join(", ")}`)
      }
    }
  }

  // --- Step 4: Deletions and renames ---
  // Removing or renaming files is inherently risky because dependent code may break.
  // Elevate to at least medium if not already high.
  const deletions = changedFiles.filter((f) => f.startsWith("DELETE:") || f.startsWith("RENAME:"))
  if (deletions.length > 0) {
    if (level === "low") level = "medium"
    reasons.push(`File deletions or renames detected`)
  }

  // --- Step 5: Fallback reason ---
  // Always include at least one reason so callers don't have to handle an empty array.
  if (reasons.length === 0) {
    reasons.push("No risk patterns matched — appears to be a low-risk change")
  }

  return {
    sha,
    level,
    reasons,
    touchesCustomization: matchedCustomizationIds.length > 0,
    customizationIds: matchedCustomizationIds,
    // Deduplicate in case the same command appears in multiple customization entries.
    testCommands: [...new Set(matchedTestCommands)],
  }
}
