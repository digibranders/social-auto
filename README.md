# Social Auto

Plans and posts social media content for clients, automatically.

You give it a client's website. It reads the site, writes a month of posts, draws the posters, and posts them
to the client's Instagram, Facebook and LinkedIn at the right times. A private dashboard shows what is
scheduled, what went out, and what failed.

## The pieces

| Folder | What it is |
|---|---|
| `scheduler/engine` | **Content engine.** Reads a website, writes the posts with AI, draws the posters. |
| `publisher` | **Publisher.** Posts to the channels, keeps the connections, renews tokens, sends alerts, answers the dashboard and the product API. |
| `dashboard` | **Dashboard.** The private web app: clients, channels, calendar, edits, connect links, guides. |
| `deploy` | Everything needed to run it on the server: services, timers, web config, settings list. |
| `docs` | The product API (for apps like Brandbasket) and design mockups. |

## How a post gets made and sent

1. The **engine** reads the client's website and writes the posts and posters.
2. It saves them in this repository, and the **publisher** reads the schedule from the same folder.
3. Every day at the post's time, the publisher sends it to each connected channel.
4. The **dashboard** shows the result. You can edit a post before it goes out.
5. If something fails, or a connection is about to run out, a push alert is sent.

## Where it runs

On one server (a VPS), as two small Node services behind nginx, with systemd timers for the scheduled jobs.
See [`deploy/README.md`](deploy/README.md). Secrets live only in `/etc/social-auto/`, never in this repository.

## Working on it

Work on a branch cut from `development`, open a pull request into `development`, then a second pull request `development` into `main` (merging it deploys). See `CLAUDE.md` for the full rules. Each folder has its own tests:

```bash
cd publisher && npm test      # and: npx tsc --noEmit
cd dashboard && npm test      # and: npm run typecheck && npm run build
cd scheduler/engine && npm test
```

## More

- [`RUNBOOK.md`](RUNBOOK.md): everyday chores and what to do when an alert arrives.
- [`deploy/README.md`](deploy/README.md): setting up and updating the server.
- [`docs/product-api.md`](docs/product-api.md): how another product connects customers and posts through this.
