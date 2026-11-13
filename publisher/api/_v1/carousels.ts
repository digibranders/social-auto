/**
 * The carousel of the week: one post of 3 to 5 slides that goes out with the same slides on every channel that can take one, each with the words written for it.
 * It replaces one of the week's posts and is limited to one a week (a rejected one may be made once more). It is made from the facts the website states, so the
 * customer's website must have been read first. The customer approves or rejects the whole set, never a slide on its own.
 *
 * POST /api/v1/carousels   {"externalId", "action": "make", "networks"?: [...], "startDate"?: "2026-12-09"}   asks for this week's carousel; 202 {"job", "created"}.
 *                          The job has `kind: "carousel"` and follows the same states as a write job (`GET /api/v1/site-jobs`). Only connected channels are made for.
 *                          A second ask while one is being made is the same job (200, `created: false`). `429 CAROUSEL_LIMIT_REACHED` (with `restart`) when the week has its carousel.
 * POST /api/v1/carousels   {"externalId", "action": "weekly", "enabled": true | false}   switches the weekly carousel on or off; answers {"weekly": true | false}. While it is on, the system makes
 *                          one carousel each week, from the Thursday before it at 10:00 India time, for the Friday, for her to approve (it needs her website read, a connected channel and a
 *                          written batch). It follows the same one-a-week limit, and one that was made is never made again for the same week.
 * GET  /api/v1/carousels?externalId=...                {"carousels": [{"id", "topic", "date", "count", "status"}], "weekly": true | false}   newest first
 * GET  /api/v1/carousels?externalId=...&id=...         {"carousel": {"id", "count", "status", "slides": [{"position", "status"}], "captions": [{"network", "caption", "status"}]}, "reasons": [...]}
 * GET  /api/v1/carousels?externalId=...&id=...&slide=N&image=1   the slide itself (JPEG)
 * POST /api/v1/carousels   {"externalId", "action": "approve" | "reject", "id", "reason"?, "comment"?}   answers {"carousel": {"id", "status"}}; `X-Social-Actor` is required to decide.
 *
 * `status` is `incomplete` (not every slide is ready), `pending` (waiting for the customer), `approved`, `rejected` or `blocked` (a slide did not pass the checks).
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { channelsFor } from '../../lib/channels.js';
import { REJECTION_REASONS, type RejectionReason } from '../../lib/engine-client.js';
import { json } from '../../lib/http.js';
import { archivedAnswer, engineFor, workspaceFor } from '../../lib/product-workspace.js';
import { syncConnected } from '../../lib/connected-sync.js';
import { loadChannels } from '../../lib/store.js';

const MAX_BODY_BYTES = 4 * 1024;
const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
type Network = (typeof NETWORKS)[number];
const ACTIONS = ['make', 'approve', 'reject', 'weekly'] as const;
type Action = (typeof ACTIONS)[number];
const isNetwork = (value: unknown): value is Network => typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);
const isAction = (value: unknown): value is Action => typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
const isReason = (value: unknown): value is RejectionReason => typeof value === 'string' && (REJECTION_REASONS as readonly string[]).includes(value);
const CAROUSEL_ID = /^[A-Za-z0-9._-]{1,80}$/;

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const found = await workspaceFor(request, params.get('externalId'));
  if (found instanceof Response) return found;
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    const id = params.get('id');
    if (id === null) return json(200, { carousels: await engine.listCarousels(by), weekly: await engine.carouselWeekly(by) });
    if (!CAROUSEL_ID.test(id)) return apiError(400, 'INVALID_REQUEST', 'id is not a carousel');
    const detail = await engine.getCarousel(id, by);
    if (params.get('image') === '1') {
      const position = Number(params.get('slide'));
      const slide = detail.slides.find((s) => s.position === position);
      if (!Number.isInteger(position) || !slide?.versionId) return apiError(404, 'NOT_FOUND', 'no such slide');
      const bytes = await engine.getPosterImage(slide.versionId, by);
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return json(200, { carousel: { id: detail.id, count: detail.count, status: detail.status, slides: detail.slides.map((s) => ({ position: s.position, status: s.status })), captions: detail.captions }, reasons: [...REJECTION_REASONS] });
  } catch (error) {
    return errorResponse(error, 'read the carousels');
  }
}

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const found = await workspaceFor(request, body['externalId']);
  if (found instanceof Response) return found;
  const { workspace } = found;
  const action = body['action'];
  if (!isAction(action)) return apiError(400, 'INVALID_REQUEST', `action must be one of: ${ACTIONS.join(', ')}`);
  const away = action === 'make' || action === 'weekly' ? archivedAnswer(workspace) : null;
  if (away) return away;
  const id = body['id'];
  if (action !== 'make' && action !== 'weekly' && (typeof id !== 'string' || !CAROUSEL_ID.test(id))) return apiError(400, 'INVALID_REQUEST', 'id is required');
  let comment: string | undefined;
  if (action === 'reject') {
    if (!isReason(body['reason'])) return apiError(400, 'INVALID_REASON', `reason must be one of: ${REJECTION_REASONS.join(', ')}`);
    if (body['comment'] !== undefined && (typeof body['comment'] !== 'string' || body['comment'].length > 500)) return apiError(400, 'INVALID_REQUEST', 'comment must be text of at most 500 characters');
    comment = typeof body['comment'] === 'string' && body['comment'] !== '' ? body['comment'] : undefined;
  }
  const startAsked = body['startDate'];
  if (action === 'make' && startAsked !== undefined && (typeof startAsked !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startAsked))) return apiError(400, 'INVALID_REQUEST', 'startDate must be a day like 2026-12-09');

  try {
    const engine = engineFor(found.product.id, workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, action === 'make' ? (request.headers.has('x-social-actor') ? actorOf(request) : null) : actorOf(request));
    if (action === 'weekly') {
      if (typeof body['enabled'] !== 'boolean') return apiError(400, 'INVALID_REQUEST', 'enabled must be true or false');
      return json(200, { weekly: await engine.setCarouselWeekly(body['enabled'], by) });
    }
    if (action === 'approve') return json(200, { carousel: { id: id as string, status: await engine.approveCarousel(id as string, by) } });
    if (action === 'reject') return json(200, { carousel: { id: id as string, status: await engine.rejectCarousel(id as string, body['reason'] as RejectionReason, comment, by) } });

    // Make: the website must have been read (the carousel is made from what it states), and only connected channels are made for.
    if (workspace.website === undefined) return apiError(409, 'CONFLICT', 'read the customer\'s website first (start a batch), so a carousel can be made from what it states');
    const { file: channels } = await loadChannels();
    const connected = [...new Set(channelsFor(channels, workspace.brand).map((c) => c.platform))].filter(isNetwork);
    const asked = body['networks'];
    if (asked !== undefined && (!Array.isArray(asked) || asked.length === 0 || !asked.every(isNetwork))) return apiError(400, 'INVALID_NETWORKS', `networks must be a list of: ${NETWORKS.join(', ')}`);
    const networks = [...new Set((asked as Network[] | undefined) ?? connected)].filter((n) => connected.includes(n));
    if (networks.length === 0) return apiError(400, 'CHANNEL_NOT_CONNECTED', 'connect at least one account first, or say which connected networks to make it for');
    // The poster service is told which networks are connected before anything is drawn.
    await syncConnected(engine, workspace.brand, by);
    const made = await engine.startCarousel({ site: workspace.website, networks, ...(typeof startAsked === 'string' ? { startDate: startAsked } : {}), actor: by });
    return json(made.created ? 202 : 200, { job: made.job, created: made.created });
  } catch (error) {
    return errorResponse(error, 'make the carousel');
  }
}
