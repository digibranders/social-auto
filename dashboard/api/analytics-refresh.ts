/**
 * POST /api/analytics-refresh   {"brand": "<client id>"}
 * "Refresh now" on a client's Analytics tab. Signed-in people only, from this site's own pages only; the publisher reads the numbers (read only, and it skips
 * anything read in the last few minutes), reached with a secret the browser never sees.
 */
import { describeError, json } from '../lib/http.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const BRAND = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;
/** The publisher may be reading several networks, so it is given longer than a plain read. */
const TIMEOUT_MS = 90_000;

export async function POST(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });
  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'Refreshing is not configured' });
  if (Number(request.headers.get('content-length') ?? 0) > 1024) return json(413, { error: 'That is too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const brand = body?.['brand'];
  if (typeof brand !== 'string' || !BRAND.test(brand)) return json(400, { error: 'Invalid request' });
  try {
    const response = await fetch(new URL('/api/analytics-refresh', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer: unknown = await response.json().catch(() => null);
    if (response.ok) return json(200, { ok: true });
    const message = (answer as { error?: unknown } | null)?.error;
    const known = response.status >= 400 && response.status < 500 && typeof message === 'string';
    return json(known || response.status === 503 ? response.status : 502, { error: typeof message === 'string' && (known || response.status === 503) ? message : `The publisher answered ${response.status}` });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
