# Runbook

Everyday chores and what to do when an alert arrives. Written so anyone can follow it, with or without Claude.

## How it fits together

| Piece | Where | Does what |
|---|---|---|
| **Content engine** | `scheduler/engine` (runs on the Mac) | Reads a client's website, writes posts, draws posters. Weekly job: Mondays 10:00. |
| **Publisher** | `publisher/` → Vercel project `social-publisher` | Posts to Instagram every day 10:00-10:59 IST, renews the token weekly, sends alerts, serves the private status feed. |
| **Dashboard** | `dashboard/` → Vercel project `social-dashboard` | Calendar behind a login: what is scheduled, published, missed. Posts that have not gone out yet can be edited (caption, hashtags, picture) or reverted. |
| **Local scheduler** (optional) | `scheduler/upstream` (Docker) | The old self-hosted dashboard. Not needed for posting. |

Flow: Monday job → commits posts to GitHub `main` → Vercel deploys → publisher posts daily → dashboard reads the publisher's status feed.
Work on `development`, open a pull request, merge into `main`. Merging to `main` deploys both Vercel projects.

## Alerts (push, via ntfy: topic in `ALERT_NTFY_TOPIC`)

| Alert | Meaning | What to do |
|---|---|---|
| **Instagram post failed** | Today's post did not go out. | Read the error. Token problems: see "Replace the Instagram token". A post stays due for 20 hours: after fixing, re-send it (ask Claude) or post it by hand (poster and caption are in the dashboard). |
| **Schedule running low / No scheduled posts left** | 7, 3, 1 or 0 posts left. | The Mac has probably been off on Mondays. Run the weekly job by hand (below). |
| **Instagram token renewal failed** | Weekly renewal could not extend the token. | Replace the token (below) before it expires. |
| **Instagram token changed** | Instagram returned a different token while renewing. The saved one still works until it expires. | Replace the token (below). |
| **Weekly content job failed** | The Monday job on the Mac stopped. | Read `~/Library/Logs/social-auto/weekly.log`, fix, run it by hand. |

## Chores

### Replace the Instagram token
1. developers.facebook.com → app **scheduler** → Use cases → Manage messaging & content on Instagram → Customize → **API setup with Instagram login** → **Generate token** for the account. Approve the login in Instagram if it asks.
2. Save the token in a private file (never commit or paste it anywhere else), then from the repo root:
   `printf '%s' "$TOKEN" | vercel env update INSTAGRAM_TOKEN production --sensitive --yes`
3. Vercel only applies a changed secret to **new** deployments: Vercel → `social-publisher` → Deployments → latest production → ⋯ → **Redeploy**.
4. Check: `curl -H "Authorization: Bearer $CRON_SECRET" "https://social-publisher-lovat.vercel.app/api/cron?dryRun=1&post=<post id>"` should answer `dry-run-ready`.
5. Delete the private file.

### Run the weekly job by hand
`~/social-auto-runner/scheduler/engine/scripts/weekly.sh`, or `launchctl kickstart gui/$(id -u)/com.56steve.social-auto.weekly`. The log is `~/Library/Logs/social-auto/weekly.log`.
The job works in `~/social-auto-runner`, a separate checkout of `main`; it refuses to run if that checkout has local changes or is not on `main`.

### Edit a post in the dashboard
Open a scheduled post → **Edit post**. Change the caption (max 2200 characters, 30 hashtags) or **Replace picture** (square JPG, max 4 MB), or **Revert to original**. Changes apply at once and are what gets posted at the scheduled time; no redeploy. Posts that are due, published or missed cannot be edited (Instagram does not allow changing a published caption).
Edits live in the private Vercel Blob store `social-publisher-edits` (file `overrides.json` plus `images/`), never in git. If the store cannot be read at posting time the post **fails with an alert** instead of going out unedited. The Monday job does not touch edits; deleting a post's edit (Revert) restores what the content job planned.

### Change or remove a post (in the files)
Edit `scheduler/engine/brands/<client>/week-NN.json` (caption, headline, `imagePrompt`). Delete `out/<client>/week-NN/<id>-bg.jpg` to draw a new picture. Then in `scheduler/engine`: `node src/render.ts --brand brands/<client> --plan week-NN.json`, `node src/export-publisher.ts --brand brands/<client>`, commit, pull request, merge. Do not edit a post whose time has already passed.

### Add a client
Add an entry to `scheduler/engine/clients.json` (`site`, `days`, `time`, `utcOffset`, `target: "publisher"`). The first run builds `brands/<client>/brand.json` from the website: check it. **The publisher currently posts through one Instagram account**; a second account needs support added to the publisher before its posts can go out.

### Dashboard password and sessions
The password is the Vercel variable `DASHBOARD_PASSWORD` in project `social-dashboard`: `vercel env update DASHBOARD_PASSWORD production --sensitive`, then redeploy. Changing `SESSION_SECRET` signs everyone out.

### Run the local scheduler (optional)
`cd scheduler/upstream && export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" && docker compose up -d`, then open http://localhost:4007. Its Instagram connection is not used for posting.

## Where the secrets live (names only, never values)

| Name | Where |
|---|---|
| `INSTAGRAM_TOKEN`, `INSTAGRAM_USER_ID`, `CRON_SECRET`, `STATUS_SECRET`, `EDIT_SECRET`, `PUBLIC_ORIGIN`, `ALERT_NTFY_TOPIC`, `BLOB_READ_WRITE_TOKEN` (added by connecting the store) | Vercel project `social-publisher` (Production) |
| `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `STATUS_SECRET`, `STATUS_URL`, `EDIT_SECRET` (same value as the publisher's), `EDIT_URL` | Vercel project `social-dashboard` |
| `POLLINATIONS_API_KEY`, `SCHEDULER_API_KEY`, `ALERT_NTFY_TOPIC` and the Meta/LinkedIn app keys | `scheduler/upstream/.env` on the Mac (not in git) |

## Limits to know about
- Vercel's free plan runs the daily job somewhere in the 10:00-10:59 hour, allows two cron jobs (both used), and is meant for non-commercial use.
- The Instagram token lasts about 60 days and is renewed weekly. As of 29 Oct 2026 the first real renewal had not run yet: if Instagram turns out to hand back a different token, the alert above fires and the token must be replaced by hand.
- The Mac only has to be on for the Monday job. Posts are booked about six weeks ahead, so a few missed Mondays cause no gap.
