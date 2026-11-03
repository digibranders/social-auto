#!/usr/bin/env bash
# Brings the server to the latest main and restarts the two services. Run as the `social` user.
set -euo pipefail
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")/../.."
[[ "$(git branch --show-current)" == "main" ]] || { echo "not on main" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo "uncommitted changes" >&2; exit 1; }
git pull --ff-only origin main
(cd publisher && npm ci --omit=dev --silent --no-audit --no-fund)
(cd dashboard && npm ci --silent --no-audit --no-fund && npm run build --silent)
sudo -n /bin/systemctl restart social-publisher.service social-dashboard.service
echo "deployed $(git rev-parse --short HEAD)"
