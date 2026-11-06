/**
 * GET  /api/google/pick                    the locations the signed-in Google account manages, to choose from
 * POST /api/google/pick?location=<id>      saves the chosen one for the client
 * Both use the sealed token waiting in the hidden cookie; neither ever returns it.
 */
import { describeError, json } from '../../lib/http.js';
import { askPublisher } from '../../lib/google-publisher.js';
import { clearedPickCookie, parsePickCookie, PICK_COOKIE } from '../../lib/google-flow.js';
import { isSameOrigin, isSignedIn, readCookie } from '../../lib/security.js';

const LOCATION_ID = /^\d{1,25}$/;

/** Passes the publisher's answer on as JSON; an expired waiting connection also clears its cookie. */
async function ask(action: 'locations' | 'save', payload: Record<string, unknown>): Promise<Response> {
  const { status, body } = await askPublisher(action, payload);
  const message = typeof body?.['error'] === 'string' ? body['error'] : null;
  if (status === 410) return json(410, { error: message ?? 'The waiting connection expired. Connect Google again.' }, { 'Set-Cookie': clearedPickCookie() });
  if (status === 503) return json(503, { error: message ?? 'Editing is not configured' });
  if (status < 200 || status >= 300) return json(status === 400 ? 400 : 502, { error: message ?? `The publisher answered ${status}` });
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
