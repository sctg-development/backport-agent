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
