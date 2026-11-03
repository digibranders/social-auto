# Running everything on the VPS

Two Node servers (publisher on 4021, dashboard on 4011) behind nginx, with systemd timers instead of Vercel Cron. The weekly
content job writes into the same checkout the publisher reads (`SCHEDULE_FILE`), so new posts go live without a deploy.

| What | Where on the server |
|---|---|
| Code | `/home/social/social-auto` (branch `main`) |
| Data (edits, channels, posted log, pictures) | `/var/lib/social-auto` (owner `social`, mode 700) |
| Settings | `/etc/social-auto/publisher.env`, `/etc/social-auto/dashboard.env` (root:social, 640); names in `deploy/env/` |
| Services | `social-publisher`, `social-dashboard` |
| Timers | `social-cron` (daily 10:01 IST), `social-refresh` (Mondays 10:30 IST), `social-auto-weekly` (Mondays 10:00 IST) |
| Web | `deploy/nginx/social-auto.conf`; dashboard at `/`, publisher at `/publisher/` |

## Install (first time)
1. `install -d -o social -g social -m 700 /var/lib/social-auto` and `install -d -o root -g social -m 750 /etc/social-auto`.
2. Fill the two env files from the examples; `chown root:social` and `chmod 640` them.
3. `(cd publisher && npm ci --omit=dev)` and `(cd dashboard && npm ci && npm run build)` as `social`.
4. Copy existing data into the data folder: `BLOB_READ_WRITE_TOKEN=... node publisher/scripts/export-blob.ts /var/lib/social-auto` (reads only).
5. Copy `deploy/systemd/*` to `/etc/systemd/system/`, `deploy/sudoers-social-auto` to `/etc/sudoers.d/social-auto` (mode 440, check with `visudo -c`), then `systemctl daemon-reload` and `systemctl enable --now social-publisher social-dashboard`.
6. nginx: copy `deploy/nginx/social-auto.conf` to `/etc/nginx/sites-available/`, link it into `sites-enabled`, `nginx -t`, `systemctl reload nginx`, then `certbot --nginx -d <host>`.
7. Check from the server: `curl -s http://127.0.0.1:4021/healthz` and `curl -s http://127.0.0.1:4011/healthz`.
8. Only when ready to switch posting: enable `social-cron.timer` and `social-refresh.timer`, and stop the Vercel crons (never both).

## Update
`deploy/scripts/deploy.sh` as `social`: pulls `main`, installs, builds, restarts the two services.

## Redirect addresses to add in the provider consoles
`https://<host>/api/facebook-callback`, `/api/instagram-callback`, `/api/linkedin-callback`, `/api/google/callback`.
