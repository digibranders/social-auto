/**
 * The drawn pictures of a customer's posts. The customer approves or rejects each one (or approves a whole topic at once), and may take back an approval
 * until the picture goes out.
 *
 * GET  /api/v1/posters?externalId=...[&status=pending|approved|rejected|blocked|superseded|held|open|all]   {"posters": [...], "reasons": [...]}  (pending by default)
 * GET  /api/v1/posters?externalId=...&id=...             one poster with where its facts were found and its earlier versions: {"poster": {...}}
 * GET  /api/v1/posters?externalId=...&id=...&image=1     the picture itself (JPEG)
 * POST /api/v1/posters   {"externalId", "action": "approve" | "reject" | "withdraw", "id", "reason"?, "comment"?}   answers {"decision": {"id", "status", "decidedAt"}}
 *                        (a withdraw also answers "postStopped": true when the post was already in the schedule and was stopped; 409 POST_ALREADY_SENT when it has gone out)
 * POST /api/v1/posters   {"externalId", "action": "change-words", "id", "caption"}   new words for that network's picture: a new waiting version of the same picture (no new
 *                        picture, no cost) that replaces the old one and needs approving again; answers {"poster"}. The headline is on the picture, so it cannot be changed here.
 * POST /api/v1/posters   {"externalId", "action": "redraw", "id"}   draws one more picture for that network of the post, once per poster; 202 {"job", "created"}
 * POST /api/v1/posters   {"externalId", "action": "approve-topic", "batchId", "postId"}   approves every network's waiting picture of one topic: {"decisions": [...]}
 *
 * `X-Social-Actor` names the customer's person and is required to decide. Repeating a decision gives the same answer.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { EngineError, POSTER_STATUSES, REJECTION_REASONS, type PosterStatusFilter, type PosterView, type RejectionReason } from '../../lib/engine-client.js';
import { hasGoneOut, plannedIdOf, releaseMatches, releasedPostOf, skipForCustomer, unskipForCustomer } from '../../lib/customer-skip.js';
import { json } from '../../lib/http.js';
import { loadChannels, loadOverrides, loadPosted } from '../../lib/store.js';
import { archivedAnswer, engineFor, workspaceFor } from '../../lib/product-workspace.js';

const MAX_BODY_BYTES = 4 * 1024;
const ACTIONS = ['approve', 'reject', 'withdraw', 'approve-topic', 'redraw', 'change-words'] as const;
const MAX_CAPTION_LENGTH = 3000;
/** The same per-customer cap on buying pictures as asking for a draw (see batches.ts), since a redraw buys one too. */
const MAX_DRAWS_PER_DAY = 3;
const MAX_DRAWS_PER_MONTH = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
type Action = (typeof ACTIONS)[number];
const isAction = (value: unknown): value is Action => typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
const isStatus = (value: string): value is PosterStatusFilter => (POSTER_STATUSES as readonly string[]).includes(value);
const isReason = (value: unknown): value is RejectionReason => typeof value === 'string' && (REJECTION_REASONS as readonly string[]).includes(value);
const WITHDRAWN = 'withdrawn by the customer';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const found = await workspaceFor(request, params.get('externalId'));
  if (found instanceof Response) return found;
  const status = params.get('status') ?? 'pending';
  if (!isStatus(status)) return apiError(400, 'INVALID_REQUEST', `status must be one of: ${POSTER_STATUSES.join(', ')}`);
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    const id = params.get('id');
    if (id === null) return json(200, { posters: await engine.listPosters(status, by), reasons: [...REJECTION_REASONS] });
    if (params.get('image') === '1') {
      const bytes = await engine.getPosterImage(id, by);
      return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return json(200, { poster: { ...(await engine.getPoster(id, by)) } });
  } catch (error) {
    return errorResponse(error, 'read the pictures');
  }
}

/**
 * A customer who approves again lets a post they stopped go ahead, once the release pass has put what she approved into the schedule (until then the schedule
 * still holds the old words). A skip made by the team stays. Never fails the approval. Answers whether the post is still waiting for the release.
 */
async function letGoAhead(brand: string, postId: string, approved: ReadonlyArray<{ network: string; caption: string }>): Promise<boolean> {
  try {
    const id = plannedIdOf(brand, postId);
    const { overrides } = await loadOverrides();
    if (overrides[id]?.skippedBy !== 'customer') return false;
    const released = releasedPostOf(brand, postId);
    if (!released || !releaseMatches(released, approved)) return true;
    await unskipForCustomer(id, Date.now());
    return false;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

/** Every approved picture of one post, which is what the release pass sends. */
const approvedOf = async (engine: { listPosters: (s: 'approved', by: string) => Promise<PosterView[]> }, by: string, batchId: string, postId: string): Promise<PosterView[]> =>
  (await engine.listPosters('approved', by)).filter((p) => p.batchId === batchId && p.postId === postId);

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const found = await workspaceFor(request, body['externalId']);
  if (found instanceof Response) return found;
  const action = body['action'];
  if (!isAction(action)) return apiError(400, 'INVALID_REQUEST', `action must be one of: ${ACTIONS.join(', ')}`);
  if (action === 'redraw') {
    const away = archivedAnswer(found.workspace);
    if (away) return away;
  }
  const id = body['id'];
  const batchId = body['batchId'];
  const postId = body['postId'];
  if (action === 'approve-topic') {
    if (typeof batchId !== 'string' || typeof postId !== 'string') return apiError(400, 'INVALID_REQUEST', 'batchId and postId are required');
  } else if (typeof id !== 'string') {
    return apiError(400, 'INVALID_REQUEST', 'id is required');
  }
  let words = '';
  if (action === 'change-words') {
    if (body['headline'] !== undefined) return apiError(400, 'INVALID_REQUEST', 'the headline is printed on the picture, so it cannot be changed here. Ask for a new picture instead');
    if (typeof body['caption'] !== 'string' || body['caption'].trim() === '') return apiError(400, 'CAPTION_REQUIRED', 'write the new words');
    if (body['caption'].length > MAX_CAPTION_LENGTH) return apiError(400, 'CAPTION_TOO_LONG', `the words can be at most ${MAX_CAPTION_LENGTH} characters`);
    words = body['caption'];
  }
  let comment: string | undefined;
  if (action === 'reject') {
    if (!isReason(body['reason'])) return apiError(400, 'INVALID_REASON', `reason must be one of: ${REJECTION_REASONS.join(', ')}`);
    if (body['comment'] !== undefined && (typeof body['comment'] !== 'string' || body['comment'].length > 500)) return apiError(400, 'INVALID_REQUEST', 'comment must be text of at most 500 characters');
    comment = typeof body['comment'] === 'string' && body['comment'] !== '' ? body['comment'] : undefined;
  }

  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, actorOf(request));
    const brand = found.workspace.brand;
    if (action === 'approve-topic') {
      const decisions = await engine.approveTopic(batchId as string, postId as string, by);
      const waiting = await letGoAhead(brand, postId as string, await approvedOf(engine, by, batchId as string, postId as string));
      return json(200, { decisions, ...(waiting ? { waitingForRelease: true } : {}) });
    }
    const version = id as string;
    if (action === 'approve') {
      const decision = await engine.approvePoster(version, by);
      const poster = await engine.getPoster(version, by);
      const waiting = await letGoAhead(brand, poster.postId, await approvedOf(engine, by, poster.batchId, poster.postId));
      return json(200, { decision: { ...decision }, ...(waiting ? { waitingForRelease: true } : {}) });
    }
    if (action === 'redraw') {
      const poster = await engine.getPoster(version, by);
      if (poster.status === 'approved') return apiError(409, 'CONFLICT', 'withdraw the approval first, then ask for another picture');
      if (!poster.canRedraw && poster.redrawsLeft === 0) return apiError(409, 'REDRAW_LIMIT_REACHED', 'this picture was already drawn again as often as is allowed');
      const draws = (await engine.listJobs(by)).filter((j) => j.kind === 'draw' && j.auto !== true);
      const since = (ms: number): number => draws.filter((j) => Date.now() - Date.parse(j.createdAt) < ms).length;
      if (since(DAY_MS) >= MAX_DRAWS_PER_DAY) return apiError(429, 'DRAW_LIMIT_REACHED', `a customer can ask for pictures ${MAX_DRAWS_PER_DAY} times a day; try again tomorrow`);
      if (since(30 * DAY_MS) >= MAX_DRAWS_PER_MONTH) return apiError(429, 'DRAW_LIMIT_REACHED', `a customer can ask for pictures ${MAX_DRAWS_PER_MONTH} times a month; try again later`);
      const made = await engine.redrawPoster(version, by);
      return json(made.created ? 202 : 200, { job: { ...made.job }, created: made.created });
    }
    if (action === 'change-words') {
      const old = await engine.getPoster(version, by);
      // New words for an approved picture that has already gone out cannot reach it.
      const released = old.status === 'approved' ? releasedPostOf(brand, old.postId) : null;
      if (released) {
        const [{ file: channels }, { log }] = await Promise.all([loadChannels(), loadPosted()]);
        if (hasGoneOut(released, channels, log, Date.now(), old.network)) return apiError(409, 'POST_ALREADY_SENT', 'this post has already gone out, so its words can no longer be changed');
      }
      let changed: Awaited<ReturnType<typeof engine.changePosterWords>>;
      try {
        changed = await engine.changePosterWords(version, words, by);
      } catch (error) {
        // The same words as now are not a change.
        if (error instanceof EngineError && error.status === 409 && error.engineCode === 'CONFLICT') return apiError(400, 'NOTHING_TO_CHANGE', 'these are already the words of this picture');
        throw error;
      }
      // The old approval is replaced, so the post must not go out with the old words while the new ones wait for the customer: when no other network of it is approved it is stopped now.
      let postStopped = false;
      if (released) {
        const others = (await engine.listPosters('approved', by)).filter((p) => p.postId === old.postId && p.batchId === old.batchId && p.id !== version);
        if (others.length === 0) postStopped = await skipForCustomer(plannedIdOf(brand, old.postId), Date.now());
      }
      return json(200, { poster: { ...changed }, postStopped });
    }
    if (action === 'withdraw') {
      // Only an approved picture can be taken back, and not one that has already gone out.
      const poster = await engine.getPoster(version, by);
      if (poster.status !== 'approved') return apiError(409, 'CONFLICT', 'only an approved picture can be withdrawn');
      const released = releasedPostOf(brand, poster.postId);
      if (released) {
        const [{ file: channels }, { log }] = await Promise.all([loadChannels(), loadPosted()]);
        if (hasGoneOut(released, channels, log, Date.now(), poster.network)) return apiError(409, 'POST_ALREADY_SENT', 'this post has already gone out, so it cannot be withdrawn');
      }
      const decision = await engine.rejectPoster(version, 'other', WITHDRAWN, by);
      // The engine takes the post out of the schedule at its next pass. Until then it could still go out, so when no other network of the post is approved it is stopped now.
      let postStopped = false;
      if (released) {
        const others = (await engine.listPosters('approved', by)).filter((p) => p.postId === poster.postId && p.batchId === poster.batchId && p.id !== version);
        if (others.length === 0) postStopped = await skipForCustomer(plannedIdOf(brand, poster.postId), Date.now());
      }
      return json(200, { decision: { ...decision }, postStopped });
    }
    return json(200, { decision: { ...(await engine.rejectPoster(version, body['reason'] as RejectionReason, comment, by)) } });
  } catch (error) {
    return errorResponse(error, 'record the decision');
  }
}
