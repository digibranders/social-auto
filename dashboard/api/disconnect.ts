/**
 * POST /api/disconnect?id=facebook:<page id> or linkedin:<member id>
 * Removes a connected channel. Signed-in people only, from this site's own pages only; the publisher does the work.
 */
import { describeError, json } from '../lib/http.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const CHANNEL_ID = /^(facebook:\d{5,25}|linkedin:[A-Za-z0-9_-]{4,64})$/;
const TIMEOUT_MS = 25_000;

export async function POST(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'Editing is not configured' });

  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!CHANNEL_ID.test(id)) return json(400, { error: 'Invalid channel' });

  try {
    const response = await fetch(new URL('/api/channels', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove: id }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return json(200, { ok: true });
    return json(response.status === 404 ? 404 : 502, { error: response.status === 404 ? 'That channel is already disconnected.' : `The publisher answered ${response.status}` });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
