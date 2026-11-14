# Social Auto: notes for Claude

Plans, draws and posts social media content for clients, and serves the product API that apps like Brandbasket call. Start with `README.md` (the pieces), `RUNBOOK.md` (chores, alerts) and `docs/product-api.md` (the API contract).

## Layout

| Folder | What it is |
|---|---|
| `scheduler/engine` | Content engine: reads a website, writes posts, draws posters. The review service (`src/review-server.ts`), job runner (`src/job-runner.ts`), `autopilot.ts`, `campaign-runner.ts`, weekly draw, auto-posting. |
| `publisher` | Posts to the channels, keeps connections, and serves the product API (`api/_v1/*.ts`, routes in `server/routes.ts`, logic in `lib/`). `dev/product-test-kit.ts` is a fake engine plus helpers for API tests. |
| `dashboard` | Staff web app (`web/*.ts` compiled to `public/`, `api/` proxies to the publisher). |
| `deploy` | systemd units, nginx, env examples, deploy scripts. |

TypeScript, strict, run directly by Node (no build step for engine and publisher). No `any`; throw specific errors; validate input at the edges. The product API answers `{error, code}`; every code lives in `publisher/lib/api-error.ts` (`ERROR_CODES`) and in the table in `docs/product-api.md`. A test keeps them in step, so change both.

## Branches and merging (always)

1. Cut a branch from `origin/development`.
2. Open a PR into `development`. Wait for CI (the `test` job) before merging.
3. Open a second PR `development` into `main`. Merging it deploys production through GitHub Actions ("Test and deploy").
4. Afterwards fast-forward `development` to `main`: `git push origin origin/main:refs/heads/development`.

Never commit or push straight to `main`. Do not merge, push or deploy a feature that sends posts, spends money or changes what customers see until the owner says so; build and test it locally first.

## Before saying code works

Run, in every folder you touched:

```bash
cd scheduler/engine && npx tsc --noEmit && npm test
cd publisher && npx tsc --noEmit && npm test
cd dashboard && npm run typecheck && npm test     # also: npm run build
```

The engine tests that render in Chrome can time out when the machine is busy: rerun that file alone (`node --test src/<file>.test.ts`) before calling it a failure.

## Production and secrets

- Production is one VPS (`social.digibranders.com`), not Vercel. Secrets live in `/etc/social-auto/*.env`; never put a secret, key or token in the repo, a commit, a log or a message.
- Never log in to or change the VPS yourself. Give the owner the exact commands to run.
- Never print or paste a real API key. Real AI calls cost money: use `PICTURE_MODE=placeholder LOCAL_PLACEHOLDER_PICTURES=yes` for pictures, and only make a real text or picture call when the owner has agreed.

## Running things locally

- Publisher: `cd publisher && LOCAL_STORE_DIR=<empty folder> CHANNEL_KEY=<64 hex> ... node --import ./dev/resolver.ts dev/server.ts` (see the comment at the top of `dev/server.ts` and `deploy/env/*.env.example` for the other settings). Fake networks are in `publisher/dev/fake-*.ts`.
- Engine: `cd scheduler/engine && node src/review-server.ts` and `node src/job-runner.ts` with `BRANDS_ROOT`, `JOBS_ROOT`, `PAID_LEDGER_FILE`, `REVIEW_SECRET`, `REVIEW_PRODUCT_SECRETS`. The autopilot writes brands under `brands/` relative to the working directory, and the review service looks for jobs in a `jobs/` folder beside its brands folder: run both from the same folder and use the same roots.
- Dashboard: `cd dashboard && npm run dev` (password `dev-password`; set `STATUS_URL`, `STATUS_SECRET`, `EDIT_URL`, `EDIT_SECRET` to read a real publisher).
- Test with throwaway data folders and test accounts, never the real store.

## How the customer flow works (product API)

A product (Brandbasket) creates a workspace per customer brand. Writing a batch (`POST /api/v1/site-jobs`) reads her website and writes posts; she keeps or drops topics, asks for pictures, and approves each picture. Only approved pictures are released to the calendar and posted. Settings per customer: days of the week per channel (`/api/v1/schedule`), automatic posting per channel with consent (`PATCH /api/v1/workspaces`, engine `src/auto-posting.ts`), and limits (`PRODUCT_LIMITS=off` lifts the product limits; the monthly spend limit and brand picture ceiling stay).

## Habits that matter here

- A decision that sends content out (approve, auto-approve, release) must stay on an exact, checked version of the picture and words. Never loosen the checks to make a test pass.
- Keep `docs/product-api.md` in step with every API change, and add tests with the change (the fake engine in `publisher/dev/product-test-kit.ts` is the place for new engine routes).
- Commit messages: a plain first line saying what changed for the customer or the team, then why.
