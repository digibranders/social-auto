/**
 * GET  /api/google-pick                    the locations the signed-in Google account manages, to choose from
 * POST /api/google-pick?location=<id>      saves the chosen one for the client
 * Both use the sealed token waiting in the hidden cookie; neither ever returns it.
 */
import { describeError, json } from '../lib/http.js';
import { clearedPickCookie, parsePickCookie, PICK_COOKIE } from '../lib/google-flow.js';
import { isSameOrigin, isSignedIn, readCookie } from '../lib/security.js';

const TIMEOUT_MS = 25_000;
const LOCATION_ID = /^\d{1,25}$/;

async function ask(action: 'locations' | 'save', payload: Record<string, unknown>): Promise<Response> {
  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'Editing is not configured' });
  const response = await fetch(new URL(`/api/google-connect?action=${action}`, target), {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status === 410) return json(410, { error: typeof body?.['error'] === 'string' ? body['error'] : 'The waiting connection expired. Connect Google again.' }, { 'Set-Cookie': clearedPickCookie() });
  if (!response.ok) return json(response.status === 400 ? 400 : 502, { error: typeof body?.['error'] === 'string' ? body['error'] : `The publisher answered ${response.status}` });
  return json(200, body ?? {}, action === 'save' ? { 'Set-Cookie': clearedPickCookie() } : {});
}

async function handle(request: Request, action: 'locations' | 'save'): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  const waiting = parsePickCookie(readCookie(request.headers.get('cookie'), PICK_COOKIE));
  if (!waiting) return json(410, { error: 'Nothing is waiting. Connect Google again.' });
  try {
    if (action === 'locations') return await ask('locations', { sealed: waiting.sealed, brand: waiting.brand });
    const location = new URL(request.url).searchParams.get('location') ?? '';
    if (!LOCATION_ID.test(location)) return json(400, { error: 'Invalid location' });
    return await ask('save', { sealed: waiting.sealed, brand: waiting.brand, location });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}

export const GET = (request: Request): Promise<Response> => handle(request, 'locations');

export function POST(request: Request): Promise<Response> | Response {
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });
  return handle(request, 'save');
}
