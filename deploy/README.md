# Running everything on the VPS

Two Node servers (publisher on 4021, dashboard on 4011) behind nginx, with systemd timers instead of Vercel Cron. The weekly
content job writes into the same checkout the publisher reads (`SCHEDULE_FILE`), so new posts go live without a deploy.

| What | Where on the server |
|---|---|
| Code | `/home/social/social-auto` (branch `main`) |
| Data (edits, channels, posted log, pictures) | `/var/lib/social-auto` (owner `social`, mode 700) |
| AI cost log (the dashboard's Cost tab) | `/var/lib/social-auto/usage.jsonl`: written by the weekly job (`USAGE_LOG_FILE` in its keys file), read by the publisher |
| Settings | `/etc/social-auto/publisher.env`, `/etc/social-auto/dashboard.env` (root:social, 640); names in `deploy/env/` |
| Services | `social-publisher`, `social-dashboard` |
| Timers | `social-cron` (daily 10:01 IST), `social-refresh` (Mondays 10:30 IST), `social-auto-weekly` (Mondays 10:00 IST), `social-campaigns` (every 30 minutes; makes posters for clients with a posting plan; needs `/etc/social-auto/engine.env`, see `env/engine.env.example`; leave the timer off until the test) |
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

## Update (automatic)
Merging into `main` deploys by itself (`.github/workflows/deploy.yml`):
1. GitHub runs the tests for the publisher, the dashboard and the engine. Every pull request gets the same tests.
2. If they pass, and the change touched the apps (`publisher/`, `dashboard/`, `deploy/`; not docs, not the weekly job's posts), GitHub connects to the server and runs `deploy/scripts/deploy.sh`.
3. The script waits while a scheduled job is running, pulls `main`, installs, builds and restarts the two services, then checks both answer.
4. If they do not, it goes back to the previous version and sends an alert. Fix forward by merging a fix or a revert.

By hand (as the `social` user on the server): `deploy/scripts/deploy.sh`. Or from GitHub: Actions, "Test and deploy", Run workflow.

How GitHub gets in: a dedicated key, kept in the repository's secrets as `DEPLOY_SSH_KEY`. On the server it sits in
`/root/.ssh/authorized_keys` (the server only allows SSH logins as root) with
`restrict,command="runuser -l social -c /home/social/social-auto/deploy/scripts/remote-deploy.sh"`, so whatever it asks for, the
only thing that runs is the deploy, as the unprivileged `social` user. The script remembers the commit the running apps were started from
(`/var/lib/social-auto/deployed-commit`), so a commit pulled by something else, like the weekly job, is still deployed. The repository variables `DEPLOY_HOST` and `DEPLOY_HOST_KEY` (the server's own public key,
pinned) say where. To replace the key: make a new one, put its public half in `authorized_keys`, set the secret, remove the old line.

## Redirect addresses to add in the provider consoles
`https://<host>/api/facebook-callback`, `/api/instagram-callback`, `/api/linkedin-callback`, `/api/google/callback`.
