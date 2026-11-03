# Runbook

Everyday chores and what to do when an alert arrives. Written so anyone can follow it, with or without Claude.

## How it fits together

| Piece | Where | Does what |
|---|---|---|
| **Content engine** | `scheduler/engine`, on the server (timer `social-auto-weekly`, Mondays 10:00 IST) | Reads a client's website, writes posts, draws posters, saves them to GitHub `main`. |
| **Publisher** | `publisher/`, service `social-publisher` | Posts every day, renews tokens, sends alerts, serves the private status feed and the product API. |
| **Dashboard** | `dashboard/`, service `social-dashboard`, at `https://social.digibranders.com` | Calendar behind a login: what is scheduled, published, missed. Posts that have not gone out yet can be edited (caption, hashtags, picture) or reverted. |
| **Old Vercel projects** | `social-publisher`, `social-dashboard` on Vercel | Being retired. Never let their cron and the server's timers post at the same time. |

Flow: weekly job writes the posts into the repo checkout on the server and pushes to GitHub `main` → the publisher reads the new schedule from the same folder (no deploy) → the publisher posts daily → the dashboard reads the publisher's status feed.
Work on a branch, open a pull request, merge into `main`, then run `deploy/scripts/deploy.sh` on the server. See `deploy/README.md`.

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

### Connect a client's Facebook Page
The client first makes your Facebook account an admin of their Page (Page settings, Page access, "Facebook access"; full control is not needed). Accept it, then in the dashboard click **Connect Facebook** (as that same Facebook account), choose "current Pages only" and tick the Page. The Page token is saved **encrypted** in the private store (`channels.json`) and never shown. From the next scheduled post on, each post also goes to the Page; posts from before the connection are not sent. Instagram and Facebook are independent: one failing does not stop the other, and each failure sends its own alert. To disconnect a Page: POST `/api/channels` with `{"remove": "facebook:<page id>"}` and the edit secret (a button is not built yet). While the Meta app is unpublished, only accounts with a role in the app can connect.

### Run the weekly job by hand
`~/social-auto-runner/scheduler/engine/scripts/weekly.sh`, or `launchctl kickstart gui/$(id -u)/com.56steve.social-auto.weekly`. The log is `~/Library/Logs/social-auto/weekly.log`.
The job works in `~/social-auto-runner`, a separate checkout of `main`; it refuses to run if that checkout has local changes or is not on `main`.

### Everything on the VPS
Publisher and dashboard can run as two Node servers on the VPS instead of Vercel (see `deploy/README.md`): systemd services `social-publisher` and `social-dashboard`, timers `social-cron` and `social-refresh` (replacing Vercel Cron), data in `/var/lib/social-auto`, settings in `/etc/social-auto/*.env`. Logs: `journalctl -u social-publisher -u social-dashboard -u social-cron`. Update with `deploy/scripts/deploy.sh`. Never run the Vercel crons and the server timers together, or a post can go out twice.

### Run the content engine on a Linux server
The engine runs on a Mac or on Linux. On Linux it needs Node 24, Google Chrome (`google-chrome`) and ImageMagick (`convert`, which replaces the Mac's `sips`). Settings are environment variables, so a server needs no edits to the code:

| Variable | Meaning |
|---|---|
| `CHROME_PATH` | Chrome's location. Defaults to the Mac app on a Mac and `google-chrome` on Linux. |
| `CHROME_NO_SANDBOX` | `1` if Ubuntu refuses Chrome's sandbox for a normal user. The engine only opens pages it built. |
| `SOCIAL_AUTO_ENV` | A keys file (`POLLINATIONS_API_KEY`, `SCHEDULER_API_KEY`, `ALERT_NTFY_TOPIC`). Keys already in the environment win, so a service can supply them directly. Default `scheduler/upstream/.env`. |
| `SOCIAL_AUTO_LOG_HINT` | Where an alert tells you to look for the log. |
| `POLLINATIONS_IMAGE_MODEL` | The picture model. Default is the free `zimage`. Paid models (for example `openai/gpt-image-2.5-flare`) need credit on the Pollinations account. |
| `IMAGE_COMPOSITION_HINT` | `1` asks the picture for open space where the poster layout puts its text. Off by default, so prompts are not tuned to one model. |

### Edit a post in the dashboard
Open a scheduled post → **Edit post**. Change the caption (max 2200 characters, 30 hashtags) or **Replace picture** (square JPG, max 4 MB), or **Revert to original**. Changes apply at once and are what gets posted at the scheduled time; no redeploy. Posts that are due, published or missed cannot be edited (Instagram does not allow changing a published caption).
Edits live in the private Vercel Blob store `social-publisher-edits` (file `overrides.json` plus `images/`), never in git. If the store cannot be read at posting time the post **fails with an alert** instead of going out unedited. The Monday job does not touch edits; deleting a post's edit (Revert) restores what the content job planned.

### Change or remove a post (in the files)
Edit `scheduler/engine/brands/<client>/week-NN.json` (caption, headline, `imagePrompt`). Delete `out/<client>/week-NN/<id>-bg.jpg` to draw a new picture. Then in `scheduler/engine`: `node src/render.ts --brand brands/<client> --plan week-NN.json`, `node src/export-publisher.ts --brand brands/<client>`, commit, pull request, merge. Do not edit a post whose time has already passed.

### Change how often a client posts
In `scheduler/engine/clients.json`, give the client either `"postsPerWeek": N` (1 to 7, spread evenly: 1 = Mon, 2 = Mon/Thu, 3 = Mon/Wed/Fri, 5 = Mon to Fri, 7 = daily) or exact days, `"weekdays": ["tue", "sat"]` (which wins over the number). Each Monday run adds one week's worth of posts after the last planned one. A change applies from the **next weekly run**; posts already scheduled stay as they are (delete them in the files, see "Change or remove a post", if they should go). A longer gap between posts also makes the queue last longer, so the "running low" alerts come later. The old `"days": N` (N posts on consecutive days) still works.

### Add a client
Add an entry to `scheduler/engine/clients.json` (`site`, `postsPerWeek` or `weekdays`, `time`, `utcOffset`, `target: "publisher"`). The first run builds `brands/<client>/brand.json` from the website: check it. **The publisher currently posts through one Instagram account**; a second account needs support added to the publisher before its posts can go out.

### Dashboard password and sessions
The password is the Vercel variable `DASHBOARD_PASSWORD` in project `social-dashboard`: `vercel env update DASHBOARD_PASSWORD production --sensitive`, then redeploy. Changing `SESSION_SECRET` signs everyone out.

### Run the local scheduler (optional)
`cd scheduler/upstream && export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" && docker compose up -d`, then open http://localhost:4007. Its Instagram connection is not used for posting.

## Where the secrets live (names only, never values)

| Name | Where |
|---|---|
| `INSTAGRAM_TOKEN`, `INSTAGRAM_USER_ID`, `CRON_SECRET`, `STATUS_SECRET`, `EDIT_SECRET`, `PUBLIC_ORIGIN`, `ALERT_NTFY_TOPIC`, `BLOB_READ_WRITE_TOKEN` (added by connecting the store), `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `CHANNEL_KEY` (64 hex characters; losing it makes saved channel tokens unreadable, so reconnect the Pages) | Vercel project `social-publisher` (Production) |
| `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `STATUS_SECRET`, `STATUS_URL`, `EDIT_SECRET` (same value as the publisher's), `EDIT_URL`, `FACEBOOK_APP_ID`, `FACEBOOK_CONFIG_ID` | Vercel project `social-dashboard` |
| `POLLINATIONS_API_KEY`, `SCHEDULER_API_KEY`, `ALERT_NTFY_TOPIC` and the Meta/LinkedIn app keys | `scheduler/upstream/.env` on the Mac (not in git) |

## Limits to know about
- Vercel's free plan runs the daily job somewhere in the 10:00-10:59 hour, allows two cron jobs (both used), and is meant for non-commercial use.
- The Instagram token lasts about 60 days and is renewed weekly. As of 29 Oct 2026 the first real renewal had not run yet: if Instagram turns out to hand back a different token, the alert above fires and the token must be replaced by hand.
- The Mac only has to be on for the Monday job. Posts are booked about six weeks ahead, so a few missed Mondays cause no gap.
