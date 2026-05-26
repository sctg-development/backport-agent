import "dotenv/config"
import { describe, expect, it } from "vitest"
import { Agent } from "@sctg/cline-sdk"

const hasVaultEnv = Boolean(process.env.KEYPOOL_VAULT_URL && process.env.KEYPOOL_LIVE_SECRET)
const MODEL_ID = "mistral/devstral-latest"

const vaultIntegration = hasVaultEnv ? it : it.skip

// This test intentionally talks to a real provider through the encrypted vault.
// It can fail if the remote service is unavailable or if credentials are revoked.
vaultIntegration(
  "can perform a minimal call through keypoollive with real vault credentials",
  { timeout: 120_000 },
  async () => {
    const agent = new Agent({
      providerId: "keypoollive",
      modelId: MODEL_ID,
      apiKey: "auto",
      systemPrompt: "You are a deterministic responder.",
      tools: [],
    })

    const result = await agent.run(
      'Return exactly this JSON object and nothing else: {"status":"ok","source":"keypoollive"}',
    )

    const output = (result.outputText ?? "").trim().toLowerCase()
    console.log("Agent output:", output)
    expect(output.length).toBeGreaterThan(0)
    expect(output).toContain("ok")
  },
)

describe("keypoollive vault integration preconditions", () => {
  it("documents env availability for this workspace", () => {
    expect(typeof process.env.KEYPOOL_VAULT_URL).toBe("string")
    expect(typeof process.env.KEYPOOL_LIVE_SECRET).toBe("string")
  })
})
