/**
 * The owner's review queue, for signed-in people only. The review service (the engine's review-server.ts, on the same machine) holds the queue and
 * decides what may be approved or downloaded; this function only passes requests to it with the secret the browser never sees, and only from this
 * site's own pages for anything that changes something.
 *
 *   GET  /api/review?view=list&status=pending|approved|rejected|blocked|superseded|all
 *   GET  /api/review?view=detail|image|download&id=<versionId>
 *   POST /api/review   { "id": "<versionId>", "action": "approve" }  or  { "id": "...", "action": "reject", "reason": "...", "comment": "..." }
 */
import { describeError, json } from '../lib/http.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const VERSION_ID = /^[a-z0-9][a-z0-9-]{0,62}\.[0-9a-f]{16}$/;
const STATUS = /^(pending|approved|rejected|blocked|superseded|all)$/;
const TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 4 * 1024;
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
  if (view === 'list') {
    const status = query.get('status') ?? 'pending';
    if (!STATUS.test(status)) return json(400, { error: 'Invalid request' });
    path = `/review/posts?status=${status}`;
  } else if (view === 'detail' || view === 'image' || view === 'download') {
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

  let body: { id?: unknown; action?: unknown; reason?: unknown; comment?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { error: 'Invalid request' });
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
