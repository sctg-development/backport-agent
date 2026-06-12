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
 * @file tool-helper.ts
 *
 * Typed wrapper around `createTool` from `@sctg/cline-sdk`.
 *
 * **Problem — overload resolution ambiguity:**
 * `@sctg/cline-shared/dist/tools/create.d.ts` declares two overloads of
 * `createTool`:
 *  1. `createTool(config: { inputSchema: Record<string, unknown>, ... })`
 *  2. `createTool<TSchema extends ZodTypeAny, TOutput>(config: { inputSchema: TSchema, ... })`
 *
 * TypeScript evaluates overloads in declaration order.  Because `ZodObject`
 * is structurally assignable to `Record<string, unknown>`, overload 1 always
 * wins, and the inferred input type in `execute` becomes `unknown` instead of
 * the typed schema inference from overload 2.
 *
 * **Solution:**
 * `defineTool` has the correct generic signature (overload 2's types) and casts
 * the config to `any` before forwarding to `createTool`.  TypeScript then
 * infers the Zod-typed `execute` parameter correctly at every call site.
 *
 * This is the only place where `as any` is used in the codebase.
 */

import { createTool } from "@sctg/cline-agents"
import type { AgentTool, AgentToolContext } from "@sctg/cline-sdk"
import { z } from "zod"

/**
 * Creates a fully-typed agent tool from the provided configuration.
 *
 * This is a thin wrapper around `createTool` that exists solely to fix TypeScript
 * overload resolution.  All arguments are forwarded unchanged; the only difference
 * from calling `createTool` directly is that `TSchema` is correctly inferred from
 * `inputSchema`.
 *
 * @typeParam TSchema - Zod schema type for the tool's input object.
 * @typeParam TOutput - Return type of the `execute` function.
 *
 * @param config - Tool configuration object.
 * @param config.name        - Machine-readable tool name (snake_case by convention).
 * @param config.description - Natural-language description shown to the LLM.
 * @param config.inputSchema - Zod schema that validates and types the tool's input.
 * @param config.execute     - Async function called by the agent runtime.  Receives
 *                             a fully typed `input` (inferred from `TSchema`) and
 *                             an `AgentToolContext` for runtime metadata.
 * @param config.lifecycle   - Optional lifecycle hooks (e.g. `completesRun: true`).
 * @param config.timeoutMs   - Optional per-invocation timeout in milliseconds.
 * @param config.retryable   - Whether the runtime should retry on transient failure.
 * @param config.maxRetries  - Maximum retry attempts (used when `retryable` is `true`).
 * @returns A fully constructed `AgentTool` ready to be passed to the `Agent` constructor.
 */
export function defineTool<TSchema extends z.ZodTypeAny, TOutput>(config: {
  name: string
  description: string
  inputSchema: TSchema
  execute: (input: z.infer<TSchema>, context: AgentToolContext) => Promise<TOutput>
  lifecycle?: AgentTool<z.infer<TSchema>, TOutput>["lifecycle"]
  timeoutMs?: number
  retryable?: boolean
  maxRetries?: number
}): AgentTool<z.infer<TSchema>, TOutput> {
  // Cast to `any` to bypass the overload ambiguity described above.
  // The return type annotation ensures callers still get full type safety.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createTool(config as any)
}
