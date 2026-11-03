#!/usr/bin/env bash
# The only command the GitHub deploy key may run (set in the server's authorized_keys). Whatever the caller asks for,
# the only thing that happens is a deploy of the latest main.
set -euo pipefail
exec "$(dirname "$0")/deploy.sh"
