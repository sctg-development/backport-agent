/**
 * Copyright (c) 2026 Ronan LE MEILLAT - SCTG Development
 * License: AGPL-3.0-or-later
 *
 * export-code-for-llm.ts — Enhanced LLM context exporter for Backport-agent
 *
 * Improvements over v1:
 *  - Structured YAML front-matter for LLM system context
 *  - Architecture overview section (stack, conventions, key patterns)
 *  - Per-file metadata (exports, route bindings, DB tables, Stripe events)
 *  - Token budget awareness: configurable --max-tokens=N flag
 *  - --slim mode: strips comments and blank lines to reduce token count
 *  - Migration schema summary extracted from SQL files (shown before code)
 *  - Package.json trimmed to relevant keys only (no lockfile noise)
 *  - llm.txt companion file (ultra-compact index for Haiku/fast models)
 *  - --verbose flag to inspect per-section token costs
 */

import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
    console.log(`USAGE: npx tsx scripts/export-code-for-llm.ts [options] [output-file]

Options:
  --help, -h              Show this help message
  --no-index              Skip llm.txt index generation
  --max-tokens=N          Limit total token count to N (default: unlimited)
  --slim                  Shrink output by stripping comments and blank lines
  --verbose               Show verbose output
`);
    process.exit(0);
}
const outFile       = args.find((a) => !a.startsWith("--")) ?? "llm.md";
const slim          = args.includes("--slim");
const maxTokensArg  = args.find((a) => a.startsWith("--max-tokens="));
const maxTokens     = maxTokensArg ? parseInt(maxTokensArg.split("=")[1]) : Infinity;
const withIndex     = !args.includes("--no-index");
const verbose       = args.includes("--verbose");


// ─── Helpers ──────────────────────────────────────────────────────────────────
function languageForExt(ext: string): string {
    const map: Record<string, string> = {
        ".ts": "typescript", ".tsx": "typescript",
        ".js": "javascript", ".jsx": "javascript",
        ".json": "json",     ".css": "css",    ".sql": "sql",
    };
    return map[ext] ?? "";
}

/** Rough token estimator: ~1 token per 4 chars (GPT-4 heuristic) */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/** Strip single-line and block comments + consecutive blank lines */
function slimify(src: string, ext: string): string {
    if (ext === ".sql") return src;
    return src
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*[\r\n]/gm, "");
}

/** Extract named exports from a TS/TSX file */
function extractExports(src: string): string[] {
    const re =
        /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
    const found: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) found.push(m[1]);
    return [...new Set(found)];
}

/** Build ASCII tree from relative paths */
function buildTree(paths: string[]): string[] {
    const root = new Map<string, Map<string, any>>();
    for (const p of paths) {
        const parts = p.split("/");
        let node = root;
        for (const part of parts) {
            if (!node.has(part)) node.set(part, new Map());
            const next = node.get(part);
            if (next instanceof Map) {
                node = next;
            } else {
                break;
            }
        }
    }
    const lines: string[] = [];
    function walk(map: Map<string, any>, prefix: string) {
        const entries = Array.from(map.keys()).sort();
        entries.forEach((key, index) => {
            const last = index === entries.length - 1;
            lines.push(`${prefix}${last ? "└─ " : "├─ "}${key}`);
            const child = map.get(key);
            if (child?.size > 0) walk(child, prefix + (last ? "   " : "│  "));
        });
    }
    walk(root, "");
    return lines;
}

// ─── Architecture preamble ────────────────────────────────────────────────────
const ARCHITECTURE_PREAMBLE = `
## Architecture overview

Backport-Agent is a **AI assisted tool for backporting commits from an upstream repository to a downstream repository**. It is designed to help developers automate the process of backporting changes, making it easier to maintain multiple versions of a codebase.

### Stack


`.trim();

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const root = process.cwd();

    let readmeContent = "";
    try {
        readmeContent = await fs.readFile(path.join(root, "README.md"), "utf8");
    } catch {
        // ignore
    }

    const patterns = [
        "src/**/*.{ts,tsx,js,jsx,json}",
        "apps/merchant/*.sql",
    ];
    const ignore = [
        "**/node_modules/**", "**/dist/**", "**/.next/**", "**/*.d.ts",
    ];

    const files = await fg(patterns, { cwd: root, absolute: true, onlyFiles: true, ignore });

    type CodeFile = {
        rel: string; content: string; ext: string;
        exports: string[];
    };
    type ConfigFile = { rel: string; content: string };

    const codeFiles:   CodeFile[]   = [];
    const configFiles: ConfigFile[] = [];

    for (const abs of files) {
        const rel = path.relative(root, abs);
        const ext = path.extname(rel).toLowerCase();
        const raw = await fs.readFile(abs, "utf8");

        if (ext === ".json") {
            if (rel.endsWith("package.json")) {
                try {
                    const pkg = JSON.parse(raw);
                    const trimmed = {
                        name:            pkg.name,
                        version:         pkg.version,
                        type:            pkg.type,
                        dependencies:    pkg.dependencies    ?? {},
                        devDependencies: Object.fromEntries(
                            Object.entries(pkg.devDependencies ?? {}).slice(0, 30)
                        ),
                    };
                    configFiles.push({ rel, content: JSON.stringify(trimmed, null, 2) });
                } catch {
                    configFiles.push({ rel, content: raw });
                }
            } else {
                configFiles.push({ rel, content: raw });
            }
        } else {
            const content = slim ? slimify(raw, ext) : raw;
            codeFiles.push({
                rel, content, ext,
                exports:      extractExports(raw),
            });
        }
    }

    codeFiles.sort((a, b)   => a.rel.localeCompare(b.rel));
    configFiles.sort((a, b) => a.rel.localeCompare(b.rel));

    const allPaths = [
        ...codeFiles.map((f)   => f.rel),
        ...configFiles.map((f) => f.rel),
    ];

    const now = new Date().toISOString().slice(0, 10);
    let md = "";

    // YAML front-matter
    md += `---\n`;
    md += `title: "Backport-agent an ai assistant for backporting"\n`;
    md += `description: "An ai assistant for backporting code changes from upstream repositories"\n`;
    md += `framework: backport-agent\n`;
    md += `stack: "cline sdk"\n`;
    md += `generated: "${now}"\n`;
    md += `slim_mode: ${slim}\n`;
    md += `files_total: ${allPaths.length}\n`;
    md += `---\n\n`;

    if (readmeContent) {
        md += readmeContent.trim() + "\n\n---\n\n";
    }

    md += ARCHITECTURE_PREAMBLE + "\n\n---\n\n";

    const treeLines = buildTree(allPaths);
    if (treeLines.length) {
        md += "## Project structure\n\n";
        md += "```\n" + treeLines.join("\n") + "\n```\n\n";
    }


    // Source files with per-file metadata
    if (codeFiles.length) {
        md += "## Source code\n\n";
        let tokenCount = estimateTokens(md);

        for (const file of codeFiles) {
            const lang = languageForExt(file.ext);
            let section = `### \`${file.rel}\`\n\n`;

            const metaParts: string[] = [];
            if (file.exports.length)
                metaParts.push(`**Exports:** ${file.exports.join(", ")}`);
            if (metaParts.length) section += metaParts.join("  \n") + "\n\n";

            section += "```" + lang + "\n" + file.content +
                (file.content.endsWith("\n") ? "" : "\n") + "```\n\n";

            const sectionTokens = estimateTokens(section);
            if (tokenCount + sectionTokens > maxTokens) {
                section = `### \`${file.rel}\`\n\n> _Omitted: token budget reached (--max-tokens=${maxTokens})._\n\n`;
            }
            tokenCount += sectionTokens;
            md += section;
        }
    }

    // Config files
    if (configFiles.length) {
        md += "## Configuration\n\n";
        for (const f of configFiles) {
            md += `### \`${f.rel}\`\n\n`;
            md += "```json\n" + f.content + (f.content.endsWith("\n") ? "" : "\n") + "```\n\n";
        }
    }

    await fs.writeFile(outFile, md, "utf8");
    const totalTokens = estimateTokens(md);
    console.log(
        `Exported ${allPaths.length} files → ${outFile}  (~${totalTokens.toLocaleString()} tokens${slim ? ", slim mode" : ""})`
    );

    if (withIndex) {

        const indexFile = path.join(path.dirname(outFile), "llm.txt");
        let idx = `Backport-agent e-commerce framework — source index (${now})\n`;
        idx += `Stack: Cline SDK with name @sctg/cline-sdk\n\n`;
        idx += `FILES\n`;
        for (const p of allPaths) idx += `  ${p}\n`;


        await fs.writeFile(indexFile, idx, "utf8");
        console.log(`Index written → ${indexFile}`);
    }

    if (verbose) {
        console.log(`\nToken breakdown:`);
        console.log(`  README:       ~${estimateTokens(readmeContent).toLocaleString()}`);
        console.log(`  Architecture: ~${estimateTokens(ARCHITECTURE_PREAMBLE).toLocaleString()}`);
        console.log(`  Source code:  ~${estimateTokens(codeFiles.map((f) => f.content).join("")).toLocaleString()}`);
        console.log(`  Config:       ~${estimateTokens(configFiles.map((f) => f.content).join("")).toLocaleString()}`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
