#!/usr/bin/env bash
# run-daily-sync.sh — daily unattended upstream sync via backport-agent.
#
# Designed to be launched by launchd (see org.sctg.backport-agent.plist) but can
# be run manually.  Exit codes from the agent:
#   0 = clean sync (or nothing to do)
#   2 = sync completed but needs human attention (conflicts blocked, validation
#       failed, host gates fired) — a macOS notification is raised
#   1 = fatal error — a macOS notification is raised
#
# Requirements:
#   - backport-agent/.env provides KEYPOOL_VAULT_URL, KEYPOOL_LIVE_SECRET,
#     BACKPORT_CUSTOMIZATIONS, KEYPOOL_STATE_FILE (main.mjs loads .env from cwd)
#   - `gh` authenticated (GITHUB_TOKEN is derived from it when unset)
#   - `bun run build` has produced dist/main.mjs (rebuilt here on each run)

set -u

AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLINE_REPO="$(cd "$AGENT_DIR/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/backport-agent"
LOCK_DIR="$AGENT_DIR/.daily-sync.lock"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
LOG_FILE="$LOG_DIR/sync-$STAMP.log"

mkdir -p "$LOG_DIR"

notify() {
  # $1 = title, $2 = message — best-effort macOS notification
  osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}

# ── Single-instance lock (mkdir is atomic; stale locks older than 6h are removed) ──
if [ -d "$LOCK_DIR" ]; then
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  else
    echo "Another sync is already running (lock: $LOCK_DIR) — skipping." | tee -a "$LOG_FILE"
    exit 0
  fi
fi
mkdir "$LOCK_DIR" || exit 0
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

{
  echo "=== backport-agent daily sync — $STAMP ==="

  # ── Environment for launchd (no login shell): PATH + scrub IDE/Electron vars ──
  export PATH="$HOME/.bun/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE VSCODE_CLI VSCODE_CWD VSCODE_PID 2>/dev/null || true

  # GITHUB_TOKEN is required for PR creation (sync.createPullRequest=true).
  if [ -z "${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null; then
    GITHUB_TOKEN="$(gh auth token 2>/dev/null)" && export GITHUB_TOKEN
  fi
  [ -n "${GITHUB_TOKEN:-}" ] || echo "WARNING: GITHUB_TOKEN unavailable — PR creation will be skipped."

  cd "$AGENT_DIR" || exit 1

  # Build the agent from local sources so local hardening fixes apply even
  # before they are published to npm.
  if command -v bun >/dev/null; then
    bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1
    bun run build || { notify "Backport sync" "Agent build failed"; exit 1; }
  fi

  VERBOSE=true node dist/main.mjs \
    --verbose \
    --config "$CLINE_REPO/.backport-agent/config.json" \
    --backport-customizations "$CLINE_REPO/.backport-agent/customizations.yaml"
  RC=$?

  echo "=== agent exit code: $RC ==="

  case "$RC" in
    0) echo "Clean sync." ;;
    2)
      notify "Backport sync" "Sync terminé mais nécessite une revue humaine (voir PR/rapport)."
      ;;
    *)
      notify "Backport sync" "Échec de la synchronisation (exit $RC) — voir $LOG_FILE"
      ;;
  esac

  # Keep the last 30 logs.
  ls -1t "$LOG_DIR"/sync-*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true

  exit "$RC"
} >>"$LOG_FILE" 2>&1
