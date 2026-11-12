/**
 * The written posts waiting for the customer's decision, before any picture is drawn or paid for. The customer keeps or drops each post, may change its
 * words (checked against the facts found on the website), or puts the whole batch away. Once drawing has been asked for the choices are final.
 *
 * GET  /api/v1/batches?externalId=...   {"expired": [{"id", "expiredAt"}] (batches put away because nobody decided in 14 days), "batches": [{"id", "createdAt", "networks", "signoffDefault"?, "posts": [{"id", "headline", "caption", "captions",
 *                                       "state", "edited"?, "signoff"?, "advice"?}]}], "networkRules"}
 * POST /api/v1/batches   {"externalId", "batchId", "action": "keep" | "drop" | "edit" | "close", "postId"?, and for "edit": "headline"?, "caption"?,
 *                        "network"?, "brandName"?, "domain"?}   answers {"batch"} as it is now
 * POST /api/v1/batches   {"externalId", "batchId", "action": "add-network", "network"}   writes the words for one more of her connected networks for every topic of the
 *                        batch, from the same topics (no website read). A job: 202 {"job", "created"} (kind "network"), followed in GET /api/v1/site-jobs, whose finished
 *                        job has "result": {"network", "topics": [{"postId", "outcome", "reasonCode"?, "posterIds"?}]}. For topics that are already drawn, a new WAITING picture
 *                        for that network is made (reusing a picture of the same shape at no cost; a new shape is drawn, which counts against the draw limits).
 * POST /api/v1/batches   {"externalId", "batchId", "action": "draw", "retry"?: true}   asks for pictures for the kept posts, once per batch (retry only after a
 *                        failed one); answers 202 {"job", "created"}, or 200 with the job that already exists. From then on the batch is final.
 *
 * `X-Social-Actor` names the customer's person and is required to decide. A final batch answers 409 BATCH_LOCKED; words that do not agree with the facts
 * answer 422 WORDS_NOT_ACCEPTED.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { channelsFor } from '../../lib/channels.js';
import { EngineError, EXPIRY_DAYS } from '../../lib/engine-client.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import type { JobView } from '../../lib/engine-client.js';
import { archivedAnswer, engineFor, workspaceFor } from '../../lib/product-workspace.js';
import { loadChannels } from '../../lib/store.js';
import { syncConnected } from '../../lib/connected-sync.js';

const MAX_BODY_BYTES = 16 * 1024;
const ACTIONS = ['keep', 'drop', 'edit', 'close', 'draw', 'add-network'] as const;
const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
/** How many times a customer may ask for pictures (each one costs money): a draw already waiting or finished for a batch is always just returned. */
const MAX_DRAWS_PER_DAY = 3;
const MAX_DRAWS_PER_MONTH = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
type Action = (typeof ACTIONS)[number];
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
    return json(200, { ...view, expired });
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
  if (action === 'draw' || action === 'add-network') {
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
    if (action === 'draw') {
      if (body['retry'] !== undefined && typeof body['retry'] !== 'boolean') return apiError(400, 'INVALID_REQUEST', 'retry must be true or false');
      const retry = body['retry'] === true;
      if (body['week'] !== undefined && (typeof body['week'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body['week']))) return apiError(400, 'INVALID_REQUEST', 'week must be the Monday of a week, like 2026-11-16');
      // A batch written for several weeks is drawn one week at a time: the week asked for, else the first one not settled (waiting or being drawn), so asking again never starts the next week by accident.
      await syncConnected(engine, found.workspace.brand, by);
      const written = (await engine.listBatches(by)).batches.find((b) => b.id === batchId);
      const week: string | undefined = typeof body['week'] === 'string' ? body['week'] : written?.weeks?.find((w) => w.state === 'waiting' || w.state === 'drawing')?.from;
      const allDraws: JobView[] = (await engine.listJobs(by)).filter((j) => j.kind === 'draw');
      const latest = allDraws.find((j) => j.batchId === batchId && j.week === week);
      // What the system drew by itself (the weekly draw) is not one of the customer's own asks.
      const draws = allDraws.filter((j) => j.auto !== true);
      if (!latest || retry) {
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
