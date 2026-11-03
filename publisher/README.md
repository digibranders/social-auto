# Publisher

Posts the day's scheduled post to every connected channel (Instagram, Facebook, LinkedIn, Google Business),
keeps the connections and their tokens, sends alerts, and answers the dashboard and the product API.

It runs as a normal Node server on the server (`server/main.ts`); see [`../deploy/README.md`](../deploy/README.md).
The schedule is read from `data/schedule.ts`, which the content engine rewrites each week, so new posts go
live with no deploy.

## Scheduled jobs

Run by systemd timers on the server. Each one calls the publisher with `Authorization: Bearer $CRON_SECRET`.

| Address | When | What it does |
|---|---|---|
| `/api/cron` | every day, 10:01 India time | Publishes the post that is due (it stays due for 20 hours). Never sends a post twice. `?dryRun=1&post=<id>` prepares a post without publishing. |
| `/api/refresh` | Mondays, 10:30 India time | Renews the Instagram tokens so none reaches its 60-day end. |

## Alerts

Push alerts go to the ntfy.sh topic in `ALERT_NTFY_TOPIC`:

- a post failed to publish
- a client has 7, 3, 1 or 0 scheduled posts left
- a token renewal failed, or a LinkedIn connection is about to end

Alert text never contains tokens or other secrets.

## Settings

The names are listed in [`../deploy/env/publisher.env.example`](../deploy/env/publisher.env.example). The values live in
`/etc/social-auto/publisher.env` on the server. Never commit them.

## Developing

```bash
npm test            # tests
npx tsc --noEmit    # type check
```

`dev/server.ts` runs the publisher on your own machine with a throwaway data folder (`LOCAL_STORE_DIR`), and
`dev/fake-*.ts` are pretend Facebook, Instagram, LinkedIn and Google servers for testing without real accounts.
