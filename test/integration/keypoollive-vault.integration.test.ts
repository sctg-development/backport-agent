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
