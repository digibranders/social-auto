/**
 * GET /api/facebook-callback?code=...&state=...
 * Where Facebook sends the person back. Checks the state against the cookie, hands the one-time code to the
 * publisher (which swaps it for Page tokens and stores them encrypted), then returns to the calendar.
 */
import { describeError } from '../lib/http.js';
import { callbackUrl, clearedConnectCookie, CONNECT_COOKIE, parseConnectCookie, statesMatch } from '../lib/facebook-flow.js';
import { isSignedIn, readCookie } from '../lib/security.js';

const TIMEOUT_MS = 25_000;

function back(request: Request, outcome: 'connected' | 'denied' | 'failed'): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: new URL(`/?facebook=${outcome}`, request.url).toString(), 'Set-Cookie': clearedConnectCookie(), 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return Response.redirect(new URL('/login', request.url), 302);

  const params = new URL(request.url).searchParams;
  if (params.get('error')) return back(request, 'denied');

  const saved = parseConnectCookie(readCookie(request.headers.get('cookie'), CONNECT_COOKIE));
  const code = params.get('code');
  if (!saved || !code || !statesMatch(params.get('state'), saved.state)) return back(request, 'failed');

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return back(request, 'failed');

  try {
    const response = await fetch(new URL('/api/facebook-connect', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri: callbackUrl(request), brand: saved.brand }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.error(`facebook-connect answered ${response.status}`);
    return back(request, response.ok ? 'connected' : 'failed');
  } catch (error) {
    console.error(describeError(error));
    return back(request, 'failed');
  }
}
