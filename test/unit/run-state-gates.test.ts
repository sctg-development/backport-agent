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

import { describe, expect, it } from "vitest"
import {
  createRunState,
  meetsConfidence,
  recordGateEvent,
  validationFailed,
  validationRan,
} from "../../src/agent/run-state.js"
import { CustomizationEntrySchema, CustomizationsSchema } from "../../src/customizations/schema.js"
import { classifyRisk } from "../../src/risk/classify-risk.js"

describe("run-state helpers", () => {
  it("orders confidence levels correctly", () => {
    expect(meetsConfidence("high", "medium")).toBe(true)
    expect(meetsConfidence("medium", "medium")).toBe(true)
    expect(meetsConfidence("low", "medium")).toBe(false)
    expect(meetsConfidence("medium", "high")).toBe(false)
    expect(meetsConfidence("low", "low")).toBe(true)
  })

  it("tracks validation outcomes", () => {
    const state = createRunState()
    expect(validationRan(state)).toBe(false)
    expect(validationFailed(state)).toBe(false)

    state.validations.push({ level: "high", allPassed: true })
    expect(validationRan(state)).toBe(true)
    expect(validationFailed(state)).toBe(false)

    state.validations.push({ level: "final", allPassed: false })
    expect(validationFailed(state)).toBe(true)
  })

  it("records gate events", () => {
    const state = createRunState()
    recordGateEvent(state, "test gate fired")
    expect(state.gateEvents).toEqual(["test gate fired"])
  })
})

describe("customization schema aliases", () => {
  it("canonicalizes tests → testCommands and related_files → relatedFiles", () => {
    const entry = CustomizationEntrySchema.parse({
      id: "x",
      description: "d",
      paths: ["src/**"],
      invariants: ["inv"],
      tests: ["bun run test:mine"],
      related_files: ["src/shared/api.ts"],
    })
    expect(entry.testCommands).toEqual(["bun run test:mine"])
    expect(entry.relatedFiles).toEqual(["src/shared/api.ts"])
  })

  it("prefers explicit camelCase keys over aliases", () => {
    const entry = CustomizationEntrySchema.parse({
      id: "x",
      description: "d",
      paths: ["src/**"],
      invariants: [],
      testCommands: ["bun run canonical"],
      tests: ["bun run alias"],
    })
    expect(entry.testCommands).toEqual(["bun run canonical"])
  })
})

describe("classifyRisk with relatedFiles", () => {
  const customizations = CustomizationsSchema.parse({
    customizations: [
      {
        id: "keypoollive",
        description: "keypool provider",
        paths: ["src/keypoollive/**"],
        invariants: [],
        tests: ["bun run test:mine"],
        related_files: ["src/registry/providers.ts"],
      },
    ],
  })

  it("elevates related-file changes to medium and collects testCommands", () => {
    const risk = classifyRisk("abc123", ["src/registry/providers.ts"], customizations)
    expect(risk.level).toBe("medium")
    expect(risk.customizationIds).toContain("keypoollive")
    expect(risk.testCommands).toContain("bun run test:mine")
  })

  it("keeps owned-path changes at high", () => {
    const risk = classifyRisk("abc123", ["src/keypoollive/vault.ts"], customizations)
    expect(risk.level).toBe("high")
    expect(risk.customizationIds).toContain("keypoollive")
    expect(risk.testCommands).toContain("bun run test:mine")
  })
})
