/**
 * POST /api/clients?action=add       body: {"name": "...", "website": "...", "plan": {...}}   (website and plan are optional; a plan needs the website)
 * POST /api/clients?action=set-plan  body: {"brand": "...", "plan": {...} or null}
 * POST /api/clients?action=set-website  body: {"brand": "...", "website": "..."}  (empty clears it)
 * POST /api/clients?action=remove    body: {"brand": "..."}
 * Adds or removes a client in the dashboard. Signed-in people only, from this site's own pages only; the
 * publisher does the work through a secret the browser never sees.
 */
import { describeError, json } from '../lib/http.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const ACTIONS = ['add', 'set-website', 'set-plan', 'remove'] as const;
const MAX_BODY_BYTES = 4 * 1024;
const TIMEOUT_MS = 25_000;

export async function POST(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'Editing is not configured' });

  const action = ACTIONS.find((candidate) => candidate === new URL(request.url).searchParams.get('action'));
  if (!action) return json(400, { error: 'Invalid request' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'That is too large' });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > MAX_BODY_BYTES) return json(413, { error: 'That is too large' });

  try {
    const upstream = new URL('/api/clients', target);
    upstream.searchParams.set('action', action);
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok) return json(200, typeof answer?.['brand'] === 'string' ? { brand: answer['brand'] } : { ok: true });
    // Pass the publisher's explanation on (it is written for people), but never its raw failures.
    const message = answer?.['error'];
    const known = response.status >= 400 && response.status < 500 && typeof message === 'string';
    return json(known ? response.status : 502, { error: known ? message : `The publisher answered ${response.status}` });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
