/**
 * The owner's review queue, for signed-in people only. The review service (the engine's review-server.ts, on the same machine) holds the queue and
 * decides what may be approved or downloaded; this function only passes requests to it with the secret the browser never sees, and only from this
 * site's own pages for anything that changes something.
 *
 *   GET  /api/review?view=list&status=open|pending|held|approved|rejected|blocked|superseded|all
 *   GET  /api/review?view=detail|image|download|logo&id=<versionId>
 *   GET  /api/review?view=campaigns      what is being made for each client's plans (read only)
 *   POST /api/review   { "id": "<versionId>", "action": "approve" }  or  { "id": "...", "action": "reject", "reason": "...", "comment": "..." }
 *   GET  /api/review?view=carousel&brand=<brand>&id=<carouselId>   a carousel whole: its slides in order, its captions and where it stands
 *   POST /api/review   { "carousel": { "brand", "id", "action": "approve" | "reject", "reason"?, "comment"? } }   approve or reject every slide and caption together
 *   GET  /api/review?view=copy                                  the written posts waiting to be kept or dropped (before any picture is bought)
 *   POST /api/review   { "copy": { "brand": "...", "planFile": "week-01.json", "postId": "...", "action": "keep" | "drop" } }
 *   POST /api/review   { "edit": { "brand", "planFile", "postId", "headline", "caption", "network"? } }   change the words of a written post (checked by the service)
 *   POST /api/review   { "close": { "brand", "planFile" } }           put a written batch away without drawing it
 *   POST /api/review   { "draw": { "brand", "planFile", "client"?, "retry"? } }   draw the kept posts of a batch (once only; "retry" after a failed draw draws only the posts that still have no picture)
 *   POST /api/review   { "job": { "site", "page"?, "networks", "weeks"?, "postsPerWeek"? } }   read a website (or one page) and write its posts (answers with the job)
 *   GET  /api/review?view=jobs                                         the jobs, newest first;  GET /api/review?view=job&id=<jobId>   one job
 */
import { describeError, json } from '../lib/http.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const VERSION_ID = /^[a-z0-9][a-z0-9-]{0,62}\.[0-9a-f]{16}$/;
const BRAND = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PLAN_FILE = /^week-\d{2,4}\.json$/;
const POST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/;
const CAROUSEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const STATUS = /^(open|pending|held|approved|rejected|blocked|superseded|all)$/;
const TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 16 * 1024;
const JOB_ID = /^job-[a-z0-9]{6,12}-[a-f0-9]{8}$/;
const NETWORKS = ['instagram', 'facebook', 'linkedin', 'google'];
/** Who is recorded as having decided: the dashboard has one password, so there is one reviewer. */
const REVIEWER = 'owner';

function target(path: string): URL | null {
  const base = process.env['REVIEW_URL'];
  return base ? new URL(`${base.replace(/\/+$/, '')}${path}`) : null;
}

async function relay(url: URL, init: RequestInit, secret: string): Promise<Response> {
  const response = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const type = response.headers.get('content-type') ?? '';
  // A picture goes through as it is; a failure keeps the service's own wording only when it is written for people (4xx), never its raw 5xx.
  if (response.ok && type.startsWith('image/')) {
    return new Response(await response.arrayBuffer(), { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', ...(response.headers.get('content-disposition') ? { 'Content-Disposition': response.headers.get('content-disposition') as string } : {}) } });
  }
  const answer: unknown = await response.json().catch(() => null);
  if (response.ok) return json(200, { ...(answer as Record<string, unknown>) });
  const message = (answer as { error?: unknown } | null)?.error;
  const known = response.status >= 400 && response.status < 500 && typeof message === 'string';
  return json(known ? response.status : 502, { error: known ? message : `The review service answered ${response.status}` });
}

export async function GET(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  const secret = process.env['REVIEW_SECRET'];
  if (!secret || !process.env['REVIEW_URL']) return json(503, { error: 'The review queue is not configured' });

  const query = new URL(request.url).searchParams;
  const view = query.get('view') ?? 'list';
  const id = query.get('id') ?? '';
  let path: string;
  if (view === 'copy') {
    path = '/review/copy';
  } else if (view === 'jobs') {
    path = '/review/jobs';
  } else if (view === 'job') {
    if (!JOB_ID.test(id)) return json(400, { error: 'Invalid request' });
    path = `/review/jobs/${id}`;
  } else if (view === 'list') {
    const status = query.get('status') ?? 'pending';
    if (!STATUS.test(status)) return json(400, { error: 'Invalid request' });
    path = `/review/posts?status=${status}`;
  } else if (view === 'carousel') {
    const brand = query.get('brand') ?? '';
    if (!BRAND.test(brand) || !CAROUSEL_ID.test(id)) return json(400, { error: 'Invalid request' });
    path = `/review/carousels/${brand}/${id}`;
  } else if (view === 'campaigns') {
    // What is being made for each client's plans (read only), for the status panel.
    path = '/review/campaigns';
  } else if (view === 'detail' || view === 'image' || view === 'download' || view === 'logo') {
    if (!VERSION_ID.test(id)) return json(400, { error: 'Invalid request' });
    path = `/review/posts/${id}${view === 'detail' ? '' : `/${view}`}`;
  } else {
    return json(400, { error: 'Invalid request' });
  }
  try {
    const url = target(path);
    return url ? await relay(url, { method: 'GET' }, secret) : json(503, { error: 'The review queue is not configured' });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });
  const secret = process.env['REVIEW_SECRET'];
  if (!secret || !process.env['REVIEW_URL']) return json(503, { error: 'The review queue is not configured' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'That is too large' });

  let body: { carousel?: Record<string, unknown>; id?: unknown; action?: unknown; reason?: unknown; comment?: unknown; copy?: Record<string, unknown>; edit?: Record<string, unknown>; close?: Record<string, unknown>; draw?: Record<string, unknown>; job?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { error: 'Invalid request' });
  }
  const send = async (path: string, method: 'POST' | 'PUT', payload: Record<string, unknown>): Promise<Response> => {
    try {
      const url = target(path);
      return url ? await relay(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: REVIEWER, ...payload }) }, secret) : json(503, { error: 'The review queue is not configured' });
    } catch (error) {
      return json(502, { error: describeError(error) });
    }
  };
  const batchOf = (value: Record<string, unknown> | undefined): { brand: string; planFile: string } | null => {
    const brand = value?.['brand'];
    const planFile = value?.['planFile'];
    return typeof brand === 'string' && BRAND.test(brand) && typeof planFile === 'string' && PLAN_FILE.test(planFile) ? { brand, planFile } : null;
  };
  const words = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' && value.length <= max ? value : null);
  if (body.carousel !== undefined) {
    const { brand, id: carouselId, action, reason, comment } = body.carousel ?? {};
    if (typeof brand !== 'string' || !BRAND.test(brand) || typeof carouselId !== 'string' || !CAROUSEL_ID.test(carouselId) || (action !== 'approve' && action !== 'reject')) return json(400, { error: 'Invalid request' });
    return send(`/review/carousels/${brand}/${carouselId}/${action}`, 'POST', action === 'approve' ? {} : { reason: typeof reason === 'string' ? reason : '', ...(typeof comment === 'string' && comment.trim() ? { comment } : {}) });
  }
  if (body.copy !== undefined) {
    const batch = batchOf(body.copy);
    const { postId, action } = body.copy ?? {};
    if (!batch || typeof postId !== 'string' || !POST_ID.test(postId) || (action !== 'keep' && action !== 'drop')) return json(400, { error: 'Invalid request' });
    return send(`/review/copy/${batch.brand}/${batch.planFile}/${encodeURIComponent(postId)}/${action}`, 'POST', {});
  }
  if (body.edit !== undefined) {
    const batch = batchOf(body.edit);
    const { postId, network } = body.edit ?? {};
    const headline = words(body.edit?.['headline'], 300);
    const caption = words(body.edit?.['caption'], 4000);
    // The sign-off pieces are optional text; empty means "back to the default". The engine checks what they say.
    const signoff = (key: string, max: number): string | undefined | null => { const v = body.edit?.[key]; return v === undefined ? undefined : typeof v === 'string' && v.length <= max ? v : null; };
    const brandName = signoff('brandName', 100);
    const domain = signoff('domain', 200);
    if (!batch || typeof postId !== 'string' || !POST_ID.test(postId) || !headline || !caption || brandName === null || domain === null || (network !== undefined && (typeof network !== 'string' || !NETWORKS.includes(network)))) return json(400, { error: 'Invalid request' });
    return send(`/review/copy/${batch.brand}/${batch.planFile}/${encodeURIComponent(postId)}/edit`, 'PUT', { headline, caption, ...(network ? { network } : {}), ...(brandName !== undefined ? { brandName } : {}), ...(domain !== undefined ? { domain } : {}) });
  }
  if (body.close !== undefined) {
    const batch = batchOf(body.close);
    if (!batch) return json(400, { error: 'Invalid request' });
    return send(`/review/copy/${batch.brand}/${batch.planFile}/close`, 'POST', {});
  }
  if (body.draw !== undefined) {
    const batch = batchOf(body.draw);
    const client = body.draw?.['client'];
    const retry = body.draw?.['retry'];
    if (!batch || (client !== undefined && (typeof client !== 'string' || !BRAND.test(client))) || (retry !== undefined && typeof retry !== 'boolean')) return json(400, { error: 'Invalid request' });
    return send(`/review/copy/${batch.brand}/${batch.planFile}/draw`, 'POST', { ...(client ? { client } : {}), ...(retry ? { retry } : {}) });
  }
  if (body.job !== undefined) {
    const site = words(body.job?.['site'], 200);
    const networks = body.job?.['networks'];
    if (!site || !Array.isArray(networks) || !networks.every((n) => typeof n === 'string' && NETWORKS.includes(n))) return json(400, { error: 'Invalid request' });
    const { page, weeks, postsPerWeek, startDate, time } = body.job ?? {};
    // The day of the first post and the time of day (India time) are optional; the engine checks that the day is tomorrow or later.
    if ((page !== undefined && typeof page !== 'boolean') || (weeks !== undefined && typeof weeks !== 'number') || (postsPerWeek !== undefined && typeof postsPerWeek !== 'number')
      || (startDate !== undefined && (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate))) || (time !== undefined && (typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time)))) return json(400, { error: 'Invalid request' });
    return send('/review/jobs', 'POST', { kind: 'copy', site, networks, ...(page ? { page } : {}), ...(weeks !== undefined ? { weeks } : {}), ...(postsPerWeek !== undefined ? { postsPerWeek } : {}), ...(startDate !== undefined ? { startDate } : {}), ...(time !== undefined ? { time } : {}) });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  if (!VERSION_ID.test(id) || (body.action !== 'approve' && body.action !== 'reject')) return json(400, { error: 'Invalid request' });
  const payload = body.action === 'approve'
    ? { by: REVIEWER }
    : { by: REVIEWER, reason: typeof body.reason === 'string' ? body.reason : '', ...(typeof body.comment === 'string' && body.comment.trim() ? { comment: body.comment } : {}) };
  try {
    const url = target(`/review/posts/${id}/${body.action}`);
    return url ? await relay(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, secret) : json(503, { error: 'The review queue is not configured' });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
