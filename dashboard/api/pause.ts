/**
 * POST /api/pause   {"scope": "all" | "brand" | "channel", "id"?: "<client or channel id>", "paused": true | false}
 * Pauses or resumes everything, one client or one channel. Signed-in people only, from this site's own pages only; the work is
 * done by the publisher, which this function reaches with a secret the browser never sees.
 */
import { describeError, json } from '../lib/http.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const SCOPES = ['all', 'brand', 'channel'] as const;
const ID = /^[A-Za-z0-9:._-]{1,100}$/;
const MAX_BODY_BYTES = 1024;
const TIMEOUT_MS = 25_000;

export async function POST(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'Pausing is not configured' });

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'That is too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const scope = SCOPES.find((candidate) => candidate === body?.['scope']);
  const id = body?.['id'];
  if (!scope || typeof body?.['paused'] !== 'boolean' || (scope !== 'all' && (typeof id !== 'string' || !ID.test(id)))) return json(400, { error: 'Invalid request' });

  try {
    const response = await fetch(new URL('/api/pause', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, ...(scope === 'all' ? {} : { id }), paused: body['paused'] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer: unknown = await response.json().catch(() => null);
    if (response.ok) return json(200, { ok: true });
    const message = (answer as { error?: unknown } | null)?.error;
    const known = response.status >= 400 && response.status < 500 && typeof message === 'string';
    return json(known ? response.status : 502, { error: known ? message : `The publisher answered ${response.status}` });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
