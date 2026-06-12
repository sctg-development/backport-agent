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
import { classifyRisk } from "../../src/risk/classify-risk.js"
import type { Customizations } from "../../src/customizations/schema.js"

const customizations: Customizations = {
  customizations: [
    {
      id: "keypoollive-provider",
      description: "custom provider",
      paths: ["src/providers/keypoollive/**"],
      invariants: ["provider registered"],
    },
  ],
}

describe("classifyRisk", () => {
  it("returns high risk when touching customization paths", () => {
    const result = classifyRisk("abc", ["src/providers/keypoollive/index.ts"], customizations)

    expect(result.level).toBe("high")
    expect(result.touchesCustomization).toBe(true)
    expect(result.customizationIds).toEqual(["keypoollive-provider"])
  })

  it("returns high risk for high-risk patterns", () => {
    const result = classifyRisk("abc", [".github/workflows/release.yml"], customizations)

    expect(result.level).toBe("high")
    expect(result.reasons.some((r) => r.includes("High-risk file pattern"))).toBe(true)
  })

  it("returns medium risk for medium-risk patterns", () => {
    const result = classifyRisk("abc", ["src/shared/types.ts"], customizations)

    expect(result.level).toBe("medium")
  })

  it("returns medium risk when delete marker is detected", () => {
    const result = classifyRisk("abc", ["DELETE:src/legacy.ts"], customizations)

    expect(result.level).toBe("medium")
    expect(result.reasons.some((r) => r.includes("deletions or renames"))).toBe(true)
  })

  it("returns low risk with fallback reason when nothing matches", () => {
    const result = classifyRisk("abc", ["README.md"], customizations)

    expect(result.level).toBe("low")
    expect(result.reasons).toEqual(["No risk patterns matched — appears to be a low-risk change"])
  })
})
