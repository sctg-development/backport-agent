/**
 * @file git/git-init.ts
 *
 * Repository initialisation and authentication helpers.
 *
 * Two exported functions:
 *
 *  - `applyGitAuth(config)`    — configures the process environment so that all
 *    subsequent git calls (via `git-client.ts`) use the right credentials.
 *    Supports SSH private keys (via `GIT_SSH_COMMAND`) and HTTP bearer tokens
 *    (via git's `http.extraHeader` environment config).
 *
 *  - `ensureWorkingDir(config)` — makes the `workingDir` ready for the agent:
 *    · If the directory does not exist (or is not a git repo): clones `fork.url`.
 *    · If it already exists: fetches all remotes to bring it up to date.
 *    · Ensures the upstream remote is properly configured when its URL is provided
 *      and it differs from the fork remote.
 *
 * Design notes:
 *  - All git I/O is synchronous (matches the rest of git-client.ts).
 *  - No secrets are stored in child-process arguments — tokens are injected via
 *    environment variables only.
 *  - `fork.url` supports any git hosting provider (GitHub, GitLab, Gitea, …).
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { execFileSync } from "node:child_process"
import { git } from "./git-client.js"
import type { SyncConfig } from "../config/schema.js"

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a config value that may reference an environment variable.
 *
 * If `value` starts with `$` the remainder is treated as an environment variable
 * name.  This lets operators write `"$GITHUB_TOKEN"` in config.json instead of
 * embedding the raw secret, keeping credentials out of version control.
 *
 * @param value - Raw config string, e.g. `"ghp_abc123"` or `"$MY_TOKEN"`.
 * @returns The resolved string, or `undefined` if the env var is not set.
 */
function resolveConfigValue(value: string): string | undefined {
  if (value.startsWith("$")) {
    return process.env[value.slice(1)]
  }
  return value
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Configures process-level environment variables so that all subsequent git
 * operations (in this process and its child processes) use the right credentials.
 *
 * Priority order:
 *  1. SSH key  (`config.auth.sshKeyPath`)     → sets `GIT_SSH_COMMAND`
 *  2. Token    (`config.auth.githubToken`)    → sets `GIT_CONFIG_*` http.extraHeader
 *  3. Fallback to `GITHUB_TOKEN` env var      → same as (2)
 *
 * If none of the above are set the function is a no-op; git will use whatever
 * credentials are already available in the environment (SSH agent, credential helper…).
 *
 * **Security note:** `GIT_SSH_COMMAND` is executed by git via a shell, so the
 * key path is wrapped in single quotes with internal single quotes escaped
 * (`'\''` sequence) to prevent shell injection if the path contains special
 * characters.
 *
 * @param config - Validated `SyncConfig` loaded from `config.json`.
 */
export function applyGitAuth(config: SyncConfig): void {
  const { sshKeyPath, githubToken } = config.auth

  // --- SSH key ---
  if (sshKeyPath) {
    // Expand leading ~ to the user's home directory.
    const keyPath = sshKeyPath.replace(/^~(?=\/|$)/, process.env.HOME ?? "")
    // Wrap in single quotes and escape embedded single quotes to prevent shell
    // injection: replace each ' with '\'' (close quote, escaped quote, reopen).
    const escapedKeyPath = keyPath.replace(/'/g, "'\\''")
    process.env.GIT_SSH_COMMAND = `ssh -i '${escapedKeyPath}' -o StrictHostKeyChecking=no -o BatchMode=yes`
    process.stderr.write(`[GitAuth] SSH key configured: ${keyPath}\n`)
    return
  }

  // --- HTTP bearer token ---
  const rawToken = githubToken ?? "$GITHUB_TOKEN"
  const token = resolveConfigValue(rawToken)
  if (token) {
    // git supports injecting config via numbered GIT_CONFIG_KEY_N / GIT_CONFIG_VALUE_N env vars.
    // This avoids writing to any config file and works without root access.
    const count = parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10)
    process.env.GIT_CONFIG_COUNT = String(count + 1)
    process.env[`GIT_CONFIG_KEY_${count}`] = "http.extraHeader"
    process.env[`GIT_CONFIG_VALUE_${count}`] = `Authorization: Bearer ${token}`
    process.stderr.write("[GitAuth] HTTP bearer token auth configured.\n")
  }
}

/**
 * Ensures that `config.workingDir` contains a ready-to-use git repository.
 *
 * **Clone** (directory absent or not a git repo):
 *  Clones `config.fork.url` into `config.workingDir`.  The parent directory is
 *  created if necessary.  Throws if `fork.url` is not set.
 *
 * **Sync** (directory is already a git repo):
 *  Runs `git fetch --all --prune` to bring all tracked remotes up to date.
 *
 * **Upstream remote**:
 *  When `config.upstream.url` is set and `upstream.remote` differs from
 *  `fork.remote`, the upstream remote is added (or its URL updated) automatically.
 *
 * @param config - Validated `SyncConfig` loaded from `config.json`.
 * @returns `true` if a network fetch was performed (existing repo case), `false`
 *          if the repo was freshly cloned (no separate fetch needed).
 * @throws If cloning is required but `fork.url` is not configured.
 */
export function ensureWorkingDir(config: SyncConfig): boolean {
  const { workingDir, upstream, fork } = config
  const isGitRepo = existsSync(`${workingDir}/.git`)
  let fetched = false

  // --- Clone if the working directory does not yet exist ---
  if (!isGitRepo) {
    if (!fork.url) {
      throw new Error(
        `[GitInit] '${workingDir}' is not a git repository and fork.url is not configured. ` +
          `Set fork.url to a valid git URL (SSH or HTTPS) to enable automatic cloning.`,
      )
    }
    // Ensure the parent directory exists (git clone does not create it).
    mkdirSync(dirname(workingDir), { recursive: true })
    process.stderr.write(`[GitInit] Cloning ${fork.url} → ${workingDir} ...\n`)
    execFileSync("git", ["clone", fork.url, workingDir], {
      // Pipe stdin, inherit stdout/stderr so clone progress is visible.
      stdio: ["pipe", "inherit", "inherit"],
    })
    process.stderr.write("[GitInit] Clone complete.\n")
    // A fresh clone already has up-to-date refs; no separate fetch needed.
    fetched = false
  } else {
    // --- Fetch all remotes to sync the existing checkout ---
    process.stderr.write(`[GitInit] ${workingDir} found — fetching all remotes...\n`)
    try {
      git(["fetch", "--all", "--prune"], workingDir)
      process.stderr.write("[GitInit] Fetch complete.\n")
      fetched = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[GitInit] Warning: fetch failed: ${msg}\n`)
      fetched = false
    }
  }

  // --- Ensure upstream remote is configured ---
  // Only act when an upstream URL is provided and the upstream remote has a
  // different name than the fork remote (avoids overwriting the fork "origin").
  if (upstream.url && upstream.remote !== fork.remote) {
    try {
      const remotes = git(["remote"], workingDir).split("\n").filter(Boolean)
      if (!remotes.includes(upstream.remote)) {
        git(["remote", "add", upstream.remote, upstream.url], workingDir)
        process.stderr.write(`[GitInit] Added remote '${upstream.remote}' → ${upstream.url}\n`)
      } else {
        const currentUrl = git(["remote", "get-url", upstream.remote], workingDir)
        if (currentUrl !== upstream.url) {
          git(["remote", "set-url", upstream.remote, upstream.url], workingDir)
          process.stderr.write(`[GitInit] Updated remote '${upstream.remote}' → ${upstream.url}\n`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[GitInit] Warning: could not configure upstream remote: ${msg}\n`)
    }
  }

  return fetched
}
