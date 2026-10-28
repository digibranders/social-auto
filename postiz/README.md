# Postiz — local test

Official stack from https://github.com/gitroomhq/postiz-docker-compose (in `upstream/`),
plus `upstream/docker-compose.override.yaml` (random JWT secret from `upstream/.env`,
app bound to 127.0.0.1 only).

- App: http://localhost:4007 (login in `test-login.txt`)
- Temporal UI: http://localhost:8080

## Commands (run inside `upstream/`)

Docker Desktop's credential helper is not on the Homebrew PATH, so prefix once per terminal:

    export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

    docker compose up -d        # start
    docker compose ps           # status
    docker compose logs -f postiz
    docker compose stop         # stop, keep data
    docker compose down -v      # remove everything incl. data

## Measured footprint (idle, 2026-10-28)

| Container | RAM |
|---|---|
| postiz (frontend + backend + orchestrator) | ~1.4 GiB (1.6 GiB at boot) |
| temporal-elasticsearch | ~590 MiB |
| temporal | ~300 MiB |
| temporal-postgresql | ~130 MiB |
| postiz-postgres | ~75 MiB |
| temporal-ui / redis / admin-tools | ~55 MiB |
| **Total** | **~2.6 GiB** |

## Next steps to post for real

1. Expose with a Cloudflare Tunnel (HTTPS) and set MAIN_URL / FRONTEND_URL /
   NEXT_PUBLIC_BACKEND_URL to the public URL.
2. Add FACEBOOK_APP_ID/SECRET (Facebook Page + Instagram) and
   LINKEDIN_CLIENT_ID/SECRET in the override, then `docker compose up -d`.
3. Add OPENAI_API_KEY for AI captions/images.
