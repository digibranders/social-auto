#!/usr/bin/env bash
# Calls one of the publisher's scheduled endpoints on this server, e.g. call-publisher.sh /api/cron
# The secret goes to curl on standard input, so it never appears in a process list or the journal.
set -euo pipefail
path="${1:?usage: call-publisher.sh /api/<job>}"
: "${CRON_SECRET:?CRON_SECRET is not set}"
printf 'Authorization: Bearer %s\n' "$CRON_SECRET" |
  curl -sS --fail-with-body --max-time 300 -H @- "http://127.0.0.1:${PORT:-4021}${path}"
echo
