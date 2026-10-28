# Scheduler

Self-hosted social media scheduler (Docker Compose, in `upstream/`) plus the content
engine (in `engine/`) that turns a website into ready-to-post Instagram content.

- Dashboard: http://localhost:4007
- Job engine UI: http://localhost:8080
- Secrets and API keys live in `upstream/.env` (never committed).

## Run the stack (inside `upstream/`)

Docker Desktop's credential helper is not on the Homebrew PATH, so prefix once per terminal:

    export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"

    docker compose up -d        # start
    docker compose ps           # status
    docker compose stop         # stop, keep data
    docker compose down -v      # remove everything incl. data

## Content engine (inside `engine/`)

    npm run autopilot -- --site example.com --channel insta_handle [--days 7] [--dry-run]
    npm run monthly                                   # every client in clients.json
    node src/export-publisher.ts --brand brands/<slug>   # copy posts to ../../publisher

`brands/<slug>/` holds the brand profile, weekly plans and history (no repeated pain points).
Rendered posters are written to `out/<slug>/<week>/`.

## Measured footprint (idle)

| Part | RAM |
|---|---|
| App (frontend + backend + workers) | ~1.4 GiB |
| Job engine + search index + its database | ~1.0 GiB |
| App database, cache, admin tools | ~0.2 GiB |
| **Total** | **~2.6 GiB** |
