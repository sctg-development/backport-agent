import { describe, expect, it } from "vitest"
import {
  checkSyntaxBalance,
  computeLineSimilarity,
  detectHallucinatedFileRefs,
  extractJson,
  ConflictResolutionOutputSchema,
  AnalyzeCommitOutputSchema,
  CheckCompatibilityOutputSchema,
} from "../../src/ai/ai-tools.js"

// ---------------------------------------------------------------------------
// checkSyntaxBalance
// ---------------------------------------------------------------------------

describe("checkSyntaxBalance", () => {
  it("reports valid for perfectly balanced TypeScript", () => {
    const code = `function foo(x: string) {\n  return [x.trim()]\n}`
    expect(checkSyntaxBalance(code, "src/foo.ts")).toEqual({ valid: true })
  })

  it("reports valid for balanced JSX", () => {
    const code = `export const A = () => { return (<div className="x">{1+1}</div>) }`
    expect(checkSyntaxBalance(code, "component.tsx")).toEqual({ valid: true })
  })

  it("detects unclosed brace in TypeScript", () => {
    const code = `function broken() {\n  const x = 1\n`
    const result = checkSyntaxBalance(code, "broken.ts")
    expect(result.valid).toBe(false)
    expect(result.issue).toMatch(/brace/i)
  })

  it("detects extra closing brace", () => {
    const code = `function ok() {}\n}\n`
    const result = checkSyntaxBalance(code, "extra.ts")
    expect(result.valid).toBe(false)
  })

  it("detects unclosed parenthesis", () => {
    const code = `const arr = [1, 2, 3\nconst x = arr.map((n) => n * 2`
    const result = checkSyntaxBalance(code, "parens.ts")
    expect(result.valid).toBe(false)
    expect(result.issue).toMatch(/paren/i)
  })

  it("detects unclosed bracket", () => {
    const code = `const arr = [1, 2, 3\n`
    const result = checkSyntaxBalance(code, "arr.ts")
    expect(result.valid).toBe(false)
    expect(result.issue).toMatch(/bracket/i)
  })

  it("skips non-JS/TS files (always valid)", () => {
    const code = `{{ not balanced`
    expect(checkSyntaxBalance(code, "template.html")).toEqual({ valid: true })
    expect(checkSyntaxBalance(code, "schema.json")).toEqual({ valid: true })
    expect(checkSyntaxBalance(code, "style.css")).toEqual({ valid: true })
  })

  it("ignores braces inside string literals", () => {
    const code = `const s = "{{unclosed}"\nfunction ok() {\n  return s\n}`
    expect(checkSyntaxBalance(code, "str.ts")).toEqual({ valid: true })
  })

  it("ignores braces inside line comments", () => {
    const code = `// { unclosed\nfunction ok() {\n  return 1\n}`
    expect(checkSyntaxBalance(code, "comment.ts")).toEqual({ valid: true })
  })

  it("ignores braces inside block comments", () => {
    const code = `/* { unclosed */\nfunction ok() {\n  return 1\n}`
    expect(checkSyntaxBalance(code, "block.ts")).toEqual({ valid: true })
  })

  it("accepts .mts and .cjs extensions", () => {
    const code = `const x = 1`
    expect(checkSyntaxBalance(code, "mod.mts")).toEqual({ valid: true })
    expect(checkSyntaxBalance(code, "mod.cjs")).toEqual({ valid: true })
  })
})

// ---------------------------------------------------------------------------
// computeLineSimilarity
// ---------------------------------------------------------------------------

describe("computeLineSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    const s = "line one\nline two\nline three"
    expect(computeLineSimilarity(s, s)).toBe(1)
  })

  it("returns 1.0 for two empty strings", () => {
    expect(computeLineSimilarity("", "")).toBe(1)
  })

  it("returns 0.0 for completely different strings", () => {
    const a = "alpha beta gamma"
    const b = "delta epsilon zeta"
    expect(computeLineSimilarity(a, b)).toBe(0)
  })

  it("returns a value in [0,1] for partial overlap", () => {
    const a = "shared\nexclusive-a"
    const b = "shared\nexclusive-b"
    const sim = computeLineSimilarity(a, b)
    expect(sim).toBeGreaterThan(0)
    expect(sim).toBeLessThan(1)
  })

  it("ignores leading/trailing whitespace differences on lines", () => {
    const a = "  hello  \n  world  "
    const b = "hello\nworld"
    expect(computeLineSimilarity(a, b)).toBe(1)
  })

  it("treats blank lines as irrelevant (filtered out)", () => {
    const a = "line1\n\n\nline2"
    const b = "line1\nline2"
    expect(computeLineSimilarity(a, b)).toBe(1)
  })

  it("returns ~0.67 for 2 shared out of 3 distinct lines", () => {
    const a = "a\nb\nc"
    const b = "a\nb\nd"
    // linesA = {a,b,c}, linesB = {a,b,d}, common=2, total=6, dice=4/6≈0.667
    expect(computeLineSimilarity(a, b)).toBeCloseTo(4 / 6, 5)
  })
})

// ---------------------------------------------------------------------------
// detectHallucinatedFileRefs
// ---------------------------------------------------------------------------

describe("detectHallucinatedFileRefs", () => {
  const actual = [
    "src/providers/keypoollive/index.ts",
    "src/shared/types.ts",
    "package.json",
  ]

  it("returns empty when all referenced files match actual files", () => {
    const fragments = [
      "Updated src/providers/keypoollive/index.ts",
      "Also touched src/shared/types.ts",
    ]
    expect(detectHallucinatedFileRefs(fragments, actual)).toEqual([])
  })

  it("detects a completely unknown file reference", () => {
    const fragments = ["Changed src/providers/unknown/helper.ts significantly"]
    const suspects = detectHallucinatedFileRefs(fragments, actual)
    expect(suspects).toContain("src/providers/unknown/helper.ts")
  })

  it("returns empty when no file-like references appear in text", () => {
    const fragments = ["This is a general summary with no file mentions"]
    expect(detectHallucinatedFileRefs(fragments, actual)).toEqual([])
  })

  it("matches partial path suffix (actual ends with the ref)", () => {
    // "types.ts" without a directory prefix should NOT trigger if the actual
    // path contains it — but "shared/types.ts" is a suffix of "src/shared/types.ts"
    const fragments = ["Also modified shared/types.ts"]
    expect(detectHallucinatedFileRefs(fragments, actual)).toEqual([])
  })

  it("detects multiple hallucinated refs across multiple fragments", () => {
    const fragments = [
      "Modifies src/ghost/alpha.ts",
      "Also updates src/phantom/beta.js",
    ]
    const suspects = detectHallucinatedFileRefs(fragments, actual)
    expect(suspects).toContain("src/ghost/alpha.ts")
    expect(suspects).toContain("src/phantom/beta.js")
  })

  it("deduplicates repeated references to the same hallucinated file", () => {
    const fragments = [
      "Modified src/ghost/alpha.ts",
      "Also changed src/ghost/alpha.ts again",
    ]
    const suspects = detectHallucinatedFileRefs(fragments, actual)
    expect(suspects.filter((s) => s === "src/ghost/alpha.ts")).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

describe("extractJson", () => {
  it("parses a plain JSON object string", () => {
    const text = '{"a": 1, "b": true}'
    expect(extractJson(text)).toEqual({ a: 1, b: true })
  })

  it("strips ```json … ``` fences before parsing", () => {
    const text = "Here is the answer:\n```json\n{\"x\": 42}\n```"
    expect(extractJson(text)).toEqual({ x: 42 })
  })

  it("strips generic ``` … ``` fences before parsing", () => {
    const text = "```\n{\"y\": \"hello\"}\n```"
    expect(extractJson(text)).toEqual({ y: "hello" })
  })

  it("extracts inline JSON from surrounding prose", () => {
    const text = 'The result is {"status":"ok","value":7} as shown above.'
    expect(extractJson(text)).toEqual({ status: "ok", value: 7 })
  })

  it("throws SyntaxError for un-parseable text", () => {
    expect(() => extractJson("not json at all")).toThrow(SyntaxError)
  })
})

// ---------------------------------------------------------------------------
// Zod output schemas
// ---------------------------------------------------------------------------

describe("ConflictResolutionOutputSchema", () => {
  it("accepts a valid resolution object", () => {
    const valid = {
      resolvedContent: "const x = 1",
      confidence: "high",
      reasoning: "Both sides agree on the final value.",
    }
    expect(() => ConflictResolutionOutputSchema.parse(valid)).not.toThrow()
  })

  it("rejects invalid confidence values", () => {
    const invalid = {
      resolvedContent: "const x = 1",
      confidence: "very-high",
      reasoning: "ok",
    }
    expect(() => ConflictResolutionOutputSchema.parse(invalid)).toThrow()
  })

  it("rejects missing resolvedContent", () => {
    const invalid = { confidence: "low", reasoning: "ok" }
    expect(() => ConflictResolutionOutputSchema.parse(invalid)).toThrow()
  })
})

describe("AnalyzeCommitOutputSchema", () => {
  it("accepts a fully valid output", () => {
    const valid = {
      summary: "Adds new provider",
      keyChanges: ["Added index.ts", "Updated package.json"],
      backportComplexity: "moderate",
      semanticRiskFactors: [],
      recommendation: "apply-with-care",
    }
    expect(() => AnalyzeCommitOutputSchema.parse(valid)).not.toThrow()
  })

  it("rejects invalid backportComplexity enum value", () => {
    const invalid = {
      summary: "x",
      keyChanges: [],
      backportComplexity: "easy",
      semanticRiskFactors: [],
      recommendation: "apply",
    }
    expect(() => AnalyzeCommitOutputSchema.parse(invalid)).toThrow()
  })

  it("rejects invalid recommendation value", () => {
    const invalid = {
      summary: "x",
      keyChanges: [],
      backportComplexity: "trivial",
      semanticRiskFactors: [],
      recommendation: "unsure",
    }
    expect(() => AnalyzeCommitOutputSchema.parse(invalid)).toThrow()
  })
})

describe("CheckCompatibilityOutputSchema", () => {
  it("accepts a fully valid output", () => {
    const valid = {
      compatible: true,
      affectedCustomizations: [],
      semanticConflicts: [],
      warnings: ["Consider reviewing the provider registration"],
      recommendation: "Proceed with backport",
    }
    expect(() => CheckCompatibilityOutputSchema.parse(valid)).not.toThrow()
  })

  it("rejects non-boolean compatible field", () => {
    const invalid = {
      compatible: "yes",
      affectedCustomizations: [],
      semanticConflicts: [],
      warnings: [],
      recommendation: "ok",
    }
    expect(() => CheckCompatibilityOutputSchema.parse(invalid)).toThrow()
  })

  it("rejects non-array fields", () => {
    const invalid = {
      compatible: false,
      affectedCustomizations: "none",
      semanticConflicts: [],
      warnings: [],
      recommendation: "review",
    }
    expect(() => CheckCompatibilityOutputSchema.parse(invalid)).toThrow()
  })
})
