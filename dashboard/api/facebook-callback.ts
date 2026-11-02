/**
 * GET /api/facebook-callback?code=...&state=...
 * Where Facebook sends the person back. Checks the state against the cookie, hands the one-time code to the
 * publisher (which swaps it for Page tokens and stores them encrypted). Where the person lands afterwards is
 * decided in lib/connect-result.ts.
 */
import { describeError } from '../lib/http.js';
import { callbackUrl, clearedConnectCookie, CONNECT_COOKIE, parseConnectCookie, statesMatch } from '../lib/facebook-flow.js';
import { finishConnect, type Outcome } from '../lib/connect-result.js';
import { readCookie } from '../lib/security.js';

const TIMEOUT_MS = 25_000;

const finish = (request: Request, outcome: Outcome, brand?: string, returnUrl: string | null = null): Response =>
  finishConnect({ request, platform: 'facebook', outcome, clearCookie: clearedConnectCookie(), ...(brand ? { brand } : {}), returnUrl });

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const saved = parseConnectCookie(readCookie(request.headers.get('cookie'), CONNECT_COOKIE));
  if (params.get('error')) return finish(request, 'denied', undefined, saved?.returnUrl ?? null);

  const code = params.get('code');
  // No cookie at all means the 30 minutes ran out (or the page was reopened in another browser).
  if (!saved) return finish(request, 'expired');
  if (!code || !statesMatch(params.get('state'), saved.state)) return finish(request, 'failed', undefined, saved.returnUrl);

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return finish(request, 'failed', undefined, saved.returnUrl);

  try {
    const response = await fetch(new URL('/api/facebook-connect', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri: callbackUrl(request), brand: saved.brand }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.error(`facebook-connect answered ${response.status}`);
    return finish(request, response.ok ? 'connected' : 'failed', saved.brand, saved.returnUrl);
  } catch (error) {
    console.error(describeError(error));
    return finish(request, 'failed', undefined, saved.returnUrl);
  }
}
