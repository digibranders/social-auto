/**
 * Proxy for Instagram Auto-DM rules on the publisher (`/api/autodm`).
 * Signed-in dashboard users only, from this site's own pages only.
 */
import { describeError, json } from '../lib/http.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const MAX_BODY_BYTES = 8 * 1024;
const TIMEOUT_MS = 25_000;

async function forward(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (request.method !== 'GET' && !isSameOrigin(request)) return json(403, { error: 'Request not allowed' });

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'Editing is not configured' });

  const incoming = new URL(request.url);
  const upstream = new URL('/api/autodm', target);
  upstream.search = incoming.search;

  let body: Uint8Array | undefined;
  if (request.method === 'POST' || request.method === 'PATCH') {
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'That is too large' });
    body = new Uint8Array(await request.arrayBuffer());
    if (body.length > MAX_BODY_BYTES) return json(413, { error: 'That is too large' });
  }

  try {
    const response = await fetch(upstream, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok) return json(200, answer ?? { ok: true });
    const message = answer?.['error'];
    const known = response.status >= 400 && response.status < 500 && typeof message === 'string';
    return json(known ? response.status : 502, { error: known ? message : `The publisher answered ${response.status}` });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
