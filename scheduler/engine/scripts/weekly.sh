#!/bin/zsh
# Weekly content run (installed as a macOS LaunchAgent, Mondays 10:00).
# Runs inside a git worktree checked out on main:
#   pull main -> generate posts for every client -> commit content -> push main -> Vercel deploys.
# Any failure sends a push alert to the ntfy topic in ALERT_NTFY_TOPIC (scheduler/upstream/.env).
set -uo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

# Alert text must stay plain ASCII (it becomes an HTTP header) and must never contain secrets.
alert() {
  local topic
  topic="$(grep -m1 '^ALERT_NTFY_TOPIC=' "$ROOT/scheduler/upstream/.env" 2>/dev/null | cut -d= -f2-)"
  [[ -n "$topic" ]] || return 0
  curl -s -m 10 -H "Title: Weekly content job failed" -H "Priority: high" -H "Tags: rotating_light" \
    -d "$1" "https://ntfy.sh/$topic" > /dev/null || true
}

fail() {
  echo "$1" >&2
  alert "$1 (log: ~/Library/Logs/social-auto/weekly.log)"
  return 1
}

# The whole body lives in a function so zsh has parsed it before running: the script pulls main,
# which can rewrite this very file, and a shell reading a file that changes underneath it misbehaves.
main() {
  cd "$ROOT" || return 1
  echo "=== weekly run $(date '+%Y-%m-%d %H:%M:%S %z') in $ROOT"

  if [[ "$(git branch --show-current)" != "main" ]]; then
    fail "This checkout is not on main, so the weekly run was skipped."; return 1
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    git status --short >&2
    fail "Uncommitted changes in the weekly job checkout, so the run was skipped."; return 1
  fi

  git pull --quiet --ff-only origin main || { fail "git pull failed."; return 1; }

  cd scheduler/engine || return 1
  npm install --silent --no-audit --no-fund || { fail "npm install failed."; return 1; }
  node src/run-clients.ts
  local run_status=$?
  [[ $run_status -eq 0 ]] || alert "One or more clients failed during the weekly run (exit $run_status)."

  cd "$ROOT" || return 1
  git add scheduler/engine/brands scheduler/engine/out publisher/public publisher/data
  if git diff --cached --quiet; then
    echo "No new content to publish."
    return $run_status
  fi

  git commit --quiet -m "Weekly content: $(date +%Y-%m-%d)"
  if git push --quiet origin main; then
    echo "Pushed content to main; Vercel will deploy it."
  else
    fail "git push failed. The content is committed locally and goes out on the next run."; return 1
  fi
  return $run_status
}

main "$@"; exit $?
