#!/bin/zsh
# Weekly content run (installed as a macOS LaunchAgent, Mondays 10:00).
# Runs inside a git worktree checked out on main:
#   pull main -> generate posts for every client -> commit content -> push main -> Vercel deploys.
set -uo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT" || exit 1

echo "=== weekly run $(date '+%Y-%m-%d %H:%M:%S %z') in $ROOT"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Refusing to run: this checkout is not on main" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to run: uncommitted changes in $ROOT" >&2
  git status --short >&2
  exit 1
fi

git pull --quiet --ff-only origin main || { echo "git pull failed" >&2; exit 1; }

cd scheduler/engine || exit 1
npm install --silent --no-audit --no-fund || { echo "npm install failed" >&2; exit 1; }
node src/run-clients.ts
run_status=$?

cd "$ROOT" || exit 1
git add scheduler/engine/brands scheduler/engine/out publisher/public
if git diff --cached --quiet; then
  echo "No new content to publish."
  exit $run_status
fi

git commit --quiet -m "Weekly content: $(date +%Y-%m-%d)"
if git push --quiet origin main; then
  echo "Pushed content to main; Vercel will deploy it."
else
  echo "git push failed; content is committed locally and will go out on the next run" >&2
  exit 1
fi
exit $run_status
