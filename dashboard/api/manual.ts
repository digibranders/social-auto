/**
 * POST /api/manual?action=image             body: the JPG file
 * POST /api/manual?action=create            body: {"brand","day","caption","imageKey","channels"}
 * POST /api/manual?action=delete&post=<id>
 * Hand-made posts. Signed-in people only, from this site's own pages only; the publisher does the work through a
 * secret the browser never sees.
 */
import { describeError, json } from '../lib/http.js';
import { PUBLISHING_OFF_MESSAGE, publishingEnabled } from '../lib/publishing.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const ACTIONS = ['image', 'create', 'delete'] as const;
type Action = (typeof ACTIONS)[number];
const POST_ID = /^manual-[0-9a-f]{12}$/;
/** Matches the publisher's limits (Vercel functions accept bodies up to 4.5 MB). */
const MAX_BODY_BYTES: Record<Action, number> = { image: 4 * 1024 * 1024, create: 16 * 1024, delete: 0 };
const TIMEOUT_MS = 25_000;

export async function POST(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'Editing is not configured' });

  const url = new URL(request.url);
  const action = ACTIONS.find((candidate) => candidate === url.searchParams.get('action'));
  const post = url.searchParams.get('post') ?? '';
  if (!action || (action === 'delete' && !POST_ID.test(post))) return json(400, { error: 'Invalid request' });
  // Making a post is publishing: refused while the switch is off. Taking a hand-made post away is always allowed.
  if (action !== 'delete' && !publishingEnabled()) return json(503, { error: PUBLISHING_OFF_MESSAGE });

  const limit = MAX_BODY_BYTES[action];
  if (Number(request.headers.get('content-length') ?? 0) > limit) return json(413, { error: 'That is too large' });
  const body = action === 'delete' ? null : new Uint8Array(await request.arrayBuffer());
  if (body && body.length > limit) return json(413, { error: 'That is too large' });

  try {
    const upstream = new URL('/api/manual', target);
    upstream.searchParams.set('action', action);
    if (action === 'delete') upstream.searchParams.set('post', post);
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': action === 'image' ? 'image/jpeg' : 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok) return json(200, action === 'image' && typeof answer?.['imageKey'] === 'string' ? { imageKey: answer['imageKey'] } : { ok: true });
    // Pass the publisher's explanation on (it is written for people), but never its raw failures.
    const message = answer?.['error'];
    const known = response.status >= 400 && response.status < 500 && typeof message === 'string';
    return json(known ? response.status : 502, { error: known ? message : `The publisher answered ${response.status}` });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
