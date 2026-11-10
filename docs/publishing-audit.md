# Publishing paths audit (owner-approval beta)

What this is: every program or route that can put something on a social platform, or hand posts to the program that does, and what controls each one.
It was made from the source tree of branch `release/owner-review`. **Nothing on the VPS was looked at**: the checks in section 4 have to be run there, by
someone with access, before the first real client post. Dates and the state of the VPS are not known from here.

Two rules apply to AI-poster content, and they are independent:

1. **Approval.** A poster of an `ai_v1` plan can leave the engine only as an approved version in the review store (the exact picture and the exact
   caption that were approved, hash-checked at release). A plan file saying "approved" counts for nothing.
2. **The publishing switch.** `SOCIAL_PUBLISHING_ENABLED` (a server setting, on only for exactly `true`, off if missing or misspelt) must be on for the
   engine to schedule or export anything, and for the dashboard to create or change a post.

## 1. Paths found in the source

| # | Path | What it can send | Approval | Switch | Verdict |
|---|------|------------------|----------|--------|---------|
| 1 | `autopilot.ts --route ai` (the default) | Nothing: makes posters and puts them in the review queue, then returns | n/a | n/a | Safe. A test asserts the AI branch contains no schedule or export call. |
| 2 | `autopilot.ts --route template`, not a dry run | Schedules to the Scheduler, or exports to the publisher's schedule file | Template plans: only for `art_v1` posts; legacy plans have none | Checked first, before any paid work | Gated by the switch. Existing template flows keep their old approval rules. |
| 3 | `schedule.ts` (`schedulePlan`) | Uploads and schedules through the Scheduler | `ai_v1`: approved version only, with its approved caption | Checked at the start (not for a dry run) | Gated. |
| 4 | `export-publisher.ts` (`exportToPublisher`) | Writes posts into the publisher's schedule file (the publisher then posts them) | `ai_v1`: approved version only | Checked first; writes nothing when off | Gated. |
| 5 | `scheduler-client.ts` `uploadImage` / `schedulePost` | The actual calls to the Scheduler | none (callers decide) | Checked inside each call | Gated at the last line, whatever called it. |
| 6 | `run-clients.ts` (the weekly run for every client in `clients.json`) | Runs `autopilot` for each client with its target | as the template route | through the autopilot | **Changed:** it now passes `--route template` explicitly. Without that the new default (`ai`) would have made it silently stop scheduling and only fill the review queue. |
| 7 | Review service (`review-server.ts`) | Nothing to a platform. Serves pictures to a signed-in owner; only approved versions download | yes | not needed | Safe: it has no platform credentials (see `deploy/env/review.env.example`). |
| 8 | Dashboard `/api/manual` (create, picture) and `/api/edit` | Create a hand-made post, change a post's caption or picture, at the publisher | none (owner action) | Refuse when off; deleting a hand-made post is still allowed | Gated. |
| 9 | Dashboard connect, disconnect, add-client routes | Connect or remove a channel, add a client at the publisher. No post is created or changed | none | none | Not publishing, but they hand credentials to the publisher. Listed in a test so a new route cannot appear unnoticed. |
| 10 | **Publisher service** (`publisher/`, `social-publisher.service`) and its daily **cron** (`social-cron.timer`, 10:01 India time) | Posts the post due today to Instagram, Facebook Pages, LinkedIn and Google locations, from its schedule file and its manual posts | none of its own (it posts what is in its schedule file) | **None: it does not read the switch** | **The one independent sender.** The switch cannot stop it, because it does not run the engine's code. See section 2. |
| 11 | Publisher product API (`/api/v1/posts`, `/api/v1/send`, `/api/v1/pictures`) | Posts supplied by an allowed product (`PRODUCTS` setting) | none of ours | none | Independent of the engine. Anyone holding a product key can post to that product's channels. Out of the engine's control. |
| 12 | Publisher `/api/manual`, `/api/edit` | Same as 8 at the publisher itself, with the shared `EDIT_SECRET` | none | none | Reachable only with `EDIT_SECRET` (the dashboard holds it). |
| 13 | The Scheduler's own web app and public API (`scheduler/upstream`, docker compose) | Anything its users schedule, to Instagram through its own connections | none of ours | none | Independent. Is it running on the VPS? Not known from here: check (section 4). |

## 2. What this means

* **AI posters cannot reach a platform on their own.** The only routes from the engine to a platform are 2 to 5, all behind the switch, and for AI plans also
  behind approval. The AI route itself sends nothing. A person can still download an approved picture and post it by hand.
* **The publisher (10) is the exception that matters.** If its timer is running and its schedule file contains a post for today, it posts, switch or no
  switch. What can put an AI poster into that schedule file is only path 4 (approved versions, switch on). So with the switch off, no AI poster is in it.
  But the publisher is also what posts the existing clients' template posts: it is live today for real accounts. **Switching the engine's publishing off does
  not stop the existing weekly posts to existing clients, and it is not meant to, but it does mean the existing flow and the new flow have to be decided about
  separately** (section 3).
* **Turning the switch off is a change for the existing system.** On a server that runs today's dashboard and engine, leaving `SOCIAL_PUBLISHING_ENABLED`
  unset switches off hand-made posts and caption or picture edits in the dashboard, and the engine's scheduling and export for the weekly client run (`run-clients`
  will stop with `PUBLISHING_DISABLED`). That is intended for a server that must not publish; on today's live server it has to be set to `true` on purpose.

## 3. Decisions for the owner (not made here)

1. **Is the existing publisher to keep running on the same server?** If yes, set `SOCIAL_PUBLISHING_ENABLED=true` in the dashboard and engine settings so existing
   clients keep working, and rely on approval to keep AI posters back (path 4 is only open to approved versions). If the first AI posts must be certain not to be
   able to go out, stop `social-cron.timer` and the publisher during the beta, or run the beta on a different machine.
2. **Existing clients' weekly run (`run-clients`):** it stays on the template route and now needs the switch on. Confirm that this is wanted.
3. **Who may use the product API (`PRODUCTS`)** during the beta.

## 4. Checks to run on the VPS (read-only; none of them changes anything)

```
systemctl list-units --type=service --state=running | grep -i social      # which of our services run (publisher, dashboard, review)
systemctl list-timers --all | grep -i social                              # social-cron.timer and social-refresh.timer: are they active
sudo -u social crontab -l; sudo crontab -l                                # any cron entry that runs the engine, run-clients or the publisher
ls /etc/cron.d /etc/cron.daily                                            # system cron
docker ps --format '{{.Names}} {{.Ports}}'                                # is the Scheduler (Postiz) running here, and on which port
ss -ltnp | grep -E ':(4011|4012|4021|4007)'                               # what listens where; all on 127.0.0.1
ls -l /etc/social-auto/                                                   # which settings files exist and who can read them
grep -c . /home/social/social-auto/publisher/data/schedule.ts             # how many posts the publisher has queued
```

What the answers must show before the first real client post: the review service runs as its own account reading only `review.env`; no process other than the
publisher (and the Scheduler, if it runs) holds platform credentials; the posts the publisher has queued are known and are not AI posters; and nobody has left a
cron entry that runs the engine with `--route template` against a real channel by accident.

## 5. Not covered here

Provider-side scheduled posts already inside Instagram or the Scheduler; whoever has the platform passwords or tokens; the Scheduler's own users. These can only
be checked on the platforms themselves.
