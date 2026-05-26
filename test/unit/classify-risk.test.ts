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
