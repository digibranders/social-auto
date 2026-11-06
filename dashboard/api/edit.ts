/**
 * POST /api/edit?post=<id>&action=caption|variants|image|revert|skip|unskip|move
 * Changes to a post that has not gone out yet. Signed-in people only, from this site's own pages only;
 * the work is done by the publisher, which this function reaches with a secret the browser never sees.
 */
import { describeError, json } from '../lib/http.js';
import { PUBLISHING_OFF_MESSAGE, publishingEnabled } from '../lib/publishing.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const ACTIONS = ['caption', 'variants', 'image', 'revert', 'skip', 'unskip', 'move'] as const;
const POST_ID = /^[A-Za-z0-9._-]{1,80}$/;
/** Matches the publisher's picture limit (Vercel functions accept bodies up to 4.5 MB). */
const MAX_BODY_BYTES: Record<(typeof ACTIONS)[number], number> = { caption: 16 * 1024, variants: 32 * 1024, image: 4 * 1024 * 1024, revert: 0, skip: 0, unskip: 0, move: 1024 };
const TIMEOUT_MS = 25_000;

export async function POST(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'Editing is not configured' });

  const url = new URL(request.url);
  const post = url.searchParams.get('post') ?? '';
  const action = ACTIONS.find((candidate) => candidate === url.searchParams.get('action'));
  if (!POST_ID.test(post) || !action) return json(400, { error: 'Invalid request' });
  // Changing what will go out is part of publishing: refused while the switch is off.
  // Skipping only stops a post from going out, so the switch never blocks it (like taking a hand-made post away); every other change can make a post go out, and waits for the switch.
  if (action !== 'skip' && !publishingEnabled()) return json(503, { error: PUBLISHING_OFF_MESSAGE });

  const limit = MAX_BODY_BYTES[action];
  if (Number(request.headers.get('content-length') ?? 0) > limit) return json(413, { error: 'That is too large' });
  const body = action === 'revert' || action === 'skip' || action === 'unskip' ? null : new Uint8Array(await request.arrayBuffer());
  if (body && body.length > limit) return json(413, { error: 'That is too large' });

  try {
    const upstream = new URL('/api/edit', target);
    upstream.searchParams.set('post', post);
    upstream.searchParams.set('action', action);
    const response = await fetch(upstream, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': action === 'image' ? 'image/jpeg' : 'application/json',
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer: unknown = await response.json().catch(() => null);
    if (response.ok) return json(200, { ok: true });
    // Pass the publisher's explanation on (it is written for people), but never its raw failures.
    const message = (answer as { error?: unknown } | null)?.error;
    const known = response.status >= 400 && response.status < 500 && typeof message === 'string';
    return json(known ? response.status : 502, { error: known ? message : `The publisher answered ${response.status}` });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
