#!/usr/bin/env bash
# Brings the server to the latest main and restarts the two services. Run as the `social` user, by hand or by the
# GitHub deploy workflow (through remote-deploy.sh).
#
# It waits while a scheduled job is running, and after the restart checks that both apps answer. If they do not, it
# goes back to the previous version and sends an alert. Fix forward afterwards (merge a fix or a revert).
set -uo pipefail

export PATH="$HOME/.local/node/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE=/etc/social-auto/publisher.env
# The commit the running apps were started from. Not the same as the checkout: the weekly job pulls main too.
MARKER=/var/lib/social-auto/deployed-commit
JOBS=(social-auto-weekly.service social-cron.service social-cron-frequent.service social-refresh.service social-campaigns.service)
MAX_WAIT_SECONDS=900

# The alert text stays plain ASCII (it becomes an HTTP header) and never holds a secret.
alert() {
  local topic
  topic="$(grep -m1 '^ALERT_NTFY_TOPIC=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  [[ -n "$topic" ]] || return 0
  curl -s -m 10 -H "Title: Deploy problem" -H "Priority: high" -H "Tags: rotating_light" -d "$1" "https://ntfy.sh/$topic" > /dev/null || true
}

busy() {
  local unit
  for unit in "${JOBS[@]}"; do systemctl is-active --quiet "$unit" && return 0; done
  return 1
}

healthy() {
  curl -fsS -m 5 http://127.0.0.1:4021/healthz > /dev/null && curl -fsS -m 5 http://127.0.0.1:4011/healthz > /dev/null
}

install_and_restart() {
  (cd publisher && npm ci --omit=dev --silent --no-audit --no-fund) || return 1
  (cd dashboard && npm ci --silent --no-audit --no-fund && npm run build --silent) || return 1
  sudo -n /bin/systemctl restart social-publisher.service social-dashboard.service || return 1
  local attempt
  for attempt in $(seq 1 20); do
    healthy && return 0
    sleep 2
  done
  return 1
}

# The whole body lives in a function so the shell has parsed it before running: the script pulls main, which can
# rewrite this very file, and a shell reading a file that changes underneath it misbehaves.
main() {
  cd "$ROOT" || return 1
  [[ "$(git branch --show-current)" == "main" ]] || { echo "not on main" >&2; return 1; }
  [[ -z "$(git status --porcelain)" ]] || { echo "uncommitted changes" >&2; return 1; }

  local waited=0
  while busy; do
    if [[ $waited -ge $MAX_WAIT_SECONDS ]]; then
      echo "a scheduled job is still running after 15 minutes, so nothing was changed" >&2
      alert "Deploy skipped: a scheduled job was still running after 15 minutes."
      return 1
    fi
    echo "waiting: a scheduled job is running"
    sleep 15
    waited=$((waited + 15))
  done

  local previous new deployed
  previous="$(git rev-parse HEAD)"
  deployed="$(cat "$MARKER" 2>/dev/null || true)"
  git pull --quiet --ff-only origin main || { echo "git pull failed" >&2; alert "Deploy failed: git pull did not work."; return 1; }
  new="$(git rev-parse HEAD)"

  if [[ "$new" == "$deployed" ]] && healthy; then
    echo "already on $(git rev-parse --short HEAD) and healthy"
    return 0
  fi

  if install_and_restart; then
    echo "$new" > "$MARKER"
    echo "deployed $(git rev-parse --short HEAD)"
    return 0
  fi

  echo "the apps did not come up healthy: going back to $(git rev-parse --short "$previous")" >&2
  git reset --hard --quiet "$previous"
  if install_and_restart; then
    echo "$previous" > "$MARKER"
    alert "Deploy of $(git rev-parse --short "$new") failed; went back to $(git rev-parse --short "$previous") and the apps are running."
  else
    alert "Deploy failed and the previous version did not come back either. Check the server now."
  fi
  return 1
}

main "$@"
exit $?
