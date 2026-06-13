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

import { defineConfig } from "vite"
import { resolve } from "node:path"
import { builtinModules } from "node:module"

/**
 * Vite 8 build configuration for @sctg/backport-agent.
 *
 * Produces a single ESM bundle (`dist/main.mjs`) with a `#!/usr/bin/env node`
 * shebang so it can be invoked directly as a CLI tool.
 *
 * All npm dependencies and Node.js built-ins are externalized so they are
 * resolved from the consumer's `node_modules` at runtime.  Only the project's
 * own TypeScript source is bundled.
 */
export default defineConfig({
  build: {
    /**
     * Target Node.js 22 — enables modern ESM syntax and native APIs like
     * `fetch`, `crypto.randomUUID()`, etc. without polyfills.
     */
    target: "node22",

    lib: {
      entry: {
        main: resolve(import.meta.dirname, "src/main.ts"),
      },
      /**
       * ES module output only.  CJS is not needed for a Node 22 CLI.
       */
      formats: ["es"],
    },

    rollupOptions: {
      external: [
        // All Node.js built-in modules (bare and `node:` prefixed)
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
        // npm dependencies — installed separately, not bundled
        /^@sctg\//,
        /^@octokit\//,
        "dotenv",
        "js-yaml",
        "minimatch",
        "tiktoken",
        "zod",
      ],
      output: {
        /**
         * Prepend the shebang so `chmod +x dist/main.mjs` or `npx backport-agent`
         * works without a wrapper script.
         */
        banner: "#!/usr/bin/env node",
        /**
         * Keep the entry name predictable (`dist/main.mjs`) regardless of any
         * Vite content-hash mechanism.
         */
        entryFileNames: "[name].mjs",
      },
    },

    outDir: "dist",
    emptyOutDir: true,
    /**
     * Keep output readable for debugging and source-map navigation.
     */
    minify: false,
    sourcemap: true,
  },
})
