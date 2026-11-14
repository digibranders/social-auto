/**
 * The written posts waiting for the customer's decision, before any picture is drawn or paid for. The customer keeps or drops each post, may change its
 * words (checked against the facts found on the website), or puts the whole batch away. Once drawing has been asked for the choices are final.
 *
 * GET  /api/v1/batches?externalId=...   {"expired": [{"id", "expiredAt"}] (batches put away because nobody decided in 14 days), "batches": [{"id", "createdAt", "networks", "signoffDefault"?, "posts": [{"id", "headline", "caption", "captions",
 *                                       "state", "edited"?, "signoff"?, "advice"?}]}], "networkRules"}
 * POST /api/v1/batches   {"externalId", "batchId", "action": "keep" | "drop" | "reset" | "edit" | "close", "postId"?, and for "edit": "headline"?, "caption"?,
 *                        "network"?, "brandName"?, "domain"?}   answers {"batch"} as it is now
 * POST /api/v1/batches   {"externalId", "batchId", "action": "add-network", "network"}   writes the words for one more of her connected networks for every topic of the
 *                        batch, from the same topics (no website read). A job: 202 {"job", "created"} (kind "network"), followed in GET /api/v1/site-jobs, whose finished
 *                        job has "result": {"network", "topics": [{"postId", "outcome", "reasonCode"?, "posterIds"?}]}. For topics that are already drawn, a new WAITING picture
 *                        for that network is made (reusing a picture of the same shape at no cost; a new shape is drawn, which counts against the draw limits).
 * POST /api/v1/batches   {"externalId", "batchId", "action": "draw", "retry"?: true}   asks for pictures for the kept posts, once per batch (retry only after a
 *                        failed one); answers 202 {"job", "created"}, or 200 with the job that already exists. From then on the batch is final.
 *
 * POST /api/v1/batches   {"externalId", "batchId", "action": "replace", "postId"}   gives a DROPPED post a new topic: a job (kind "replace", with `postId`) that writes one new post for the same day and
 *                        time, from the website's facts, for the networks the dropped post was written for and she has connected; answers 202 {"job", "created"} (200 with the job already waiting or
 *                        running for that post). When it succeeds the batch has the new post (`replaces` = the dropped post's id, state "pending"; the dropped post shows `replacedBy`). A week may have
 *                        3 new topics (`weeks[].replacementsLeft`): `429 REPLACE_LIMIT_REACHED` with `restart`; a try that writes nothing fails with `NOTHING_WRITTEN` and is not counted. Only for a dropped post
 *                        (`409 CONFLICT`), once (`409 CONFLICT`), of a week not drawn (`409 BATCH_LOCKED`), whose day is tomorrow or later (`409 DAY_PASSED`). No picture is drawn or paid for.
 *
 * POST /api/v1/batches   {"externalId", "batchId", "action": "move", "postId", "day": "2026-11-25"}   moves a written post to another day of **its own Monday-to-Sunday week**, in any state
 *                        (pending, kept, dropped), until that week is drawn; the time stays as the post has it, and two posts may share a day. The day is changed in the batch and in the plan the
 *                        pictures, the approval and the sending come from, so the post goes out on the new day. Answers 200 {"batch"} (and "warnings": ["WORDS_NAME_A_DAY"] when its words name a
 *                        weekday or say today/tomorrow: they are not rewritten, so she should read them again); the day it already has is a 200 that changes nothing. `400 INVALID_DAY` (not a
 *                        real day, or outside the post's week), `400 DAY_PASSED` (today or earlier), `409 BATCH_LOCKED` (its week was drawn or the batch put away), `404 NOT_FOUND`.
 *
 * `X-Social-Actor` names the customer's person and is required to decide. A final batch answers 409 BATCH_LOCKED; words that do not agree with the facts
 * answer 422 WORDS_NOT_ACCEPTED.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { channelsFor } from '../../lib/channels.js';
import { EngineError, EXPIRY_DAYS } from '../../lib/engine-client.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { productLimitsOff } from '../../lib/limits-switch.js';
import type { JobView } from '../../lib/engine-client.js';
import { archivedAnswer, engineFor, workspaceFor } from '../../lib/product-workspace.js';
import { loadChannels } from '../../lib/store.js';
import { syncConnected } from '../../lib/connected-sync.js';
import { nextMonday } from '../../lib/plan-days.js';

const MAX_BODY_BYTES = 16 * 1024;
const ACTIONS = ['keep', 'drop', 'reset', 'edit', 'close', 'draw', 'add-network', 'replace', 'move'] as const;
const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
/**
 * How many times a customer may ask for pictures (each one costs money): a draw already waiting or running for the same posts is always just returned. A week is drawn by the post, so a customer
 * who keeps a few topics at a time asks more than once a week; what she may spend is still bounded by the weekly pictures of each channel.
 */
const MAX_DRAWS_PER_DAY = 10;
const MAX_DRAWS_PER_MONTH = 40;
const DAY_MS = 24 * 60 * 60 * 1000;
type Action = (typeof ACTIONS)[number];
/** The day the next plan should start: the Monday after the last post of the current one, or the next Monday when she has none (or it already ended). */
function nextStart(endsOn: string | null, now: number): string {
  const next = nextMonday(now);
  if (endsOn === null || endsOn < next) return next;
  const end = new Date(`${endsOn}T00:00:00Z`);
  return new Date(end.getTime() + (((8 - end.getUTCDay()) % 7) || 7) * 86_400_000).toISOString().slice(0, 10);
}

/** A real calendar day like 2026-11-25 (not 2026-02-31 or 2026-13-40). */
const isRealDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const isAction = (value: unknown): value is Action => typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
const LIMITS = { headline: 300, caption: 3000, network: 20, brandName: 200, domain: 200 } as const;

export async function GET(request: Request): Promise<Response> {
  const found = await workspaceFor(request, new URL(request.url).searchParams.get('externalId'));
  if (found instanceof Response) return found;
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    await syncConnected(engine, found.workspace.brand, by);
    const view = await engine.listBatches(by);
    // A written batch nobody decided on in time is put away and no longer listed; it is shown here for a while so the customer can be told.
    const since = new Date(Date.now() - (EXPIRY_DAYS * 2 + 30) * 86_400_000).toISOString();
    const expired = (await engine.listExpired(since, by)).flatMap((e) => (e.kind === 'batch' ? [{ id: e.batchId, expiredAt: e.at }] : []));
    // Where her plan ends, and whether she may start the next one: when the last post is within 10 days (or she has no plan), and nothing is being written.
    const [ending, jobs] = await Promise.all([engine.plan(by).catch(() => null), engine.listJobs(by)]);
    if (ending === null) return json(200, { ...view, expired });
    const writing = jobs.some((j) => j.kind === 'write' && (j.state === 'queued' || j.state === 'running'));
    const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const daysLeft = ending.endsOn === null ? null : Math.round((Date.parse(`${ending.endsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    const plan = { startsOn: ending.startsOn, endsOn: ending.endsOn, canStartNext: !writing && (daysLeft === null || daysLeft <= 10), nextStartDate: nextStart(ending.endsOn, Date.now()) };
    return json(200, { ...view, expired, plan });
  } catch (error) {
    return errorResponse(error, 'read the written posts');
  }
}

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const found = await workspaceFor(request, body['externalId']);
  if (found instanceof Response) return found;
  const action = body['action'];
  if (!isAction(action)) return apiError(400, 'INVALID_REQUEST', `action must be one of: ${ACTIONS.join(', ')}`);
  // Asking for pictures or for more networks writes and spends; a brand that is put away does neither.
  if (action === 'draw' || action === 'add-network' || action === 'replace' || action === 'move') {
    const away = archivedAnswer(found.workspace);
    if (away) return away;
  }
  const batchId = body['batchId'];
  if (typeof batchId !== 'string') return apiError(400, 'INVALID_REQUEST', 'batchId is required');
  const postId = body['postId'];
  if (action !== 'close' && action !== 'draw' && action !== 'add-network' && typeof postId !== 'string') return apiError(400, 'INVALID_REQUEST', 'postId is required');

  const change: { headline?: string; caption?: string; network?: string; brandName?: string; domain?: string } = {};
  if (action === 'edit') {
    for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
      const value = body[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.length > LIMITS[key]) return apiError(400, 'INVALID_REQUEST', `${key} must be text of at most ${LIMITS[key]} characters`);
      change[key] = value;
    }
    if (Object.keys(change).length === 0) return apiError(400, 'NOTHING_TO_CHANGE', 'say what to change: headline, caption, brandName or domain');
  }

  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, actorOf(request));
    if (action === 'add-network') {
      const network = body['network'];
      if (typeof network !== 'string' || !(NETWORKS as readonly string[]).includes(network)) return apiError(400, 'INVALID_NETWORKS', `network must be one of: ${NETWORKS.join(', ')}`);
      const { file } = await loadChannels();
      if (!channelsFor(file, found.workspace.brand).some((c) => c.platform === network)) return apiError(400, 'CHANNEL_NOT_CONNECTED', `connect a ${network} account first`);
      try {
        const made = await engine.addNetwork(batchId, network, by);
        return json(made.created ? 202 : 200, { job: { ...made.job }, created: made.created });
      } catch (error) {
        if (error instanceof EngineError && error.status === 409 && error.engineCode === 'CONFLICT') return apiError(409, 'NETWORK_ALREADY_THERE', 'this batch already has that network');
        throw error;
      }
    }
    if (action === 'move') {
      // Another day for a written post, within its own Monday-to-Sunday week, until the week is drawn. The time stays as the post has it.
      const to = body['day'];
      if (typeof to !== 'string' || !isRealDay(to)) return apiError(400, 'INVALID_DAY', 'day must be a real day like 2026-11-25');
      const moved = await engine.moveWrittenPost(batchId, postId as string, to, by);
      return json(200, { batch: moved.batch, ...(moved.warnings.length > 0 ? { warnings: moved.warnings } : {}) });
    }
    if (action === 'replace') {
      // A new topic for a dropped post of a week that is not drawn: a job that writes one post for the same day, from the website's facts. Words only; no picture until she keeps it and draws.
      try {
        await syncConnected(engine, found.workspace.brand, by);
        const made = await engine.replaceWrittenPost(batchId, postId as string, by);
        return json(made.created ? 202 : 200, { job: { ...made.job }, created: made.created });
      } catch (error) {
        if (error instanceof EngineError && error.status === 409 && error.engineCode === 'CONFLICT') return apiError(409, 'CONFLICT', 'only a post that was dropped can be given a new topic, and only once');
        throw error;
      }
    }
    if (action === 'draw') {
      if (body['retry'] !== undefined && typeof body['retry'] !== 'boolean') return apiError(400, 'INVALID_REQUEST', 'retry must be true or false');
      const retry = body['retry'] === true;
      if (body['week'] !== undefined && (typeof body['week'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body['week']))) return apiError(400, 'INVALID_REQUEST', 'week must be the Monday of a week, like 2026-11-16');
      // A batch written for several weeks is drawn one week at a time: the week asked for, else the first one not settled (waiting or being drawn), so asking again never starts the next week by accident.
      await syncConnected(engine, found.workspace.brand, by);
      const written = (await engine.listBatches(by)).batches.find((b) => b.id === batchId);
      const week: string | undefined = typeof body['week'] === 'string' ? body['week'] : written?.weeks?.find((w) => w.state === 'waiting' || w.state === 'drawing' || w.state === 'partly_drawn')?.from;
      const allDraws: JobView[] = (await engine.listJobs(by)).filter((j) => j.kind === 'draw');
      const latest = allDraws.find((j) => j.batchId === batchId && j.week === week);
      // What the system drew by itself (the weekly draw) is not one of the customer's own asks.
      const draws = allDraws.filter((j) => j.auto !== true);
      // Every new round of a week is one more ask (only a double tap on a draw that is still waiting or running is not).
      // PRODUCT_LIMITS=off lifts the limits on asking for pictures (testing only).
      if (!productLimitsOff() && (!latest || retry || (latest.state !== 'queued' && latest.state !== 'running'))) {
        const since = (ms: number): number => draws.filter((j) => Date.now() - Date.parse(j.createdAt) < ms).length;
        if (since(DAY_MS) >= MAX_DRAWS_PER_DAY) return apiError(429, 'DRAW_LIMIT_REACHED', `a customer can ask for pictures ${MAX_DRAWS_PER_DAY} times a day; try again tomorrow`);
        if (since(30 * DAY_MS) >= MAX_DRAWS_PER_MONTH) return apiError(429, 'DRAW_LIMIT_REACHED', `a customer can ask for pictures ${MAX_DRAWS_PER_MONTH} times a month; try again later`);
      }
      const made = await engine.startDraw(batchId, retry, by, week);
      return json(made.created ? 202 : 200, { job: { ...made.job }, created: made.created });
    }
    const post = typeof postId === 'string' ? postId : '';
    const batch = action === 'close' ? await engine.closeBatch(batchId, by) : action === 'edit' ? await engine.editWrittenPost(batchId, post, change, by) : await engine.decideWrittenPost(batchId, post, action, by);
    return json(200, { batch });
  } catch (error) {
    return errorResponse(error, 'change the written posts');
  }
}
