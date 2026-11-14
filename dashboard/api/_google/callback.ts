/**
 * GET /api/google/callback?code=...&state=...
 * Where Google sends the person back. The state must match the cookie set when they left. The one-time code goes
 * to the publisher, which swaps it for a refresh token and stores it encrypted. With one location it is saved at
 * once; with several, the person chooses (the sealed token waits in a hidden cookie). A signed-in team member lands in
 * the dashboard; a client with no login sees plain pages.
 */
import { guardFor, refusal } from '../../lib/connect-guard.js';
import { describeError } from '../../lib/http.js';
import { statesMatch } from '../../lib/facebook-flow.js';
import { finishConnect, type Outcome } from '../../lib/connect-result.js';
import { callbackUrl, clearedConnectCookie, clearedDoneCookie, GOOGLE_COOKIE, parseConnectCookie, pickCookie } from '../../lib/google-flow.js';
import { isSignedIn, readCookie } from '../../lib/security.js';

const TIMEOUT_MS = 25_000;

const finish = (request: Request, outcome: Outcome, brand?: string, returnUrl: string | null = null, heldBy?: string): Response =>
  finishConnect({ request, platform: 'google', outcome, clearCookie: clearedConnectCookie(), ...(brand ? { brand } : {}), returnUrl, ...(heldBy ? { heldBy } : {}) });

/** Several locations were found: a team member picks in the dashboard, a client (or a product's customer) on a plain page. */
function choose(request: Request, brand: string, sealed: string, returnUrl: string | null): Response {
  const signedIn = returnUrl === null && isSignedIn(request, process.env['SESSION_SECRET'], Date.now());
  const to = signedIn ? new URL(`/?google=choose#/client/${brand}/channels`, request.url) : new URL('/api/google/choose', request.url);
  const headers = new Headers({ Location: to.toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearedConnectCookie());
  headers.append('Set-Cookie', clearedDoneCookie());
  headers.append('Set-Cookie', pickCookie(brand, sealed, returnUrl));
  return new Response(null, { status: 302, headers });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const saved = parseConnectCookie(readCookie(request.headers.get('cookie'), GOOGLE_COOKIE));
  if (params.get('error')) return finish(request, 'denied', undefined, saved?.returnUrl ?? null);

  const code = params.get('code');
  if (!saved || !code || !statesMatch(params.get('state'), saved.state)) return finish(request, 'failed', undefined, saved?.returnUrl ?? null);

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return finish(request, 'failed', undefined, saved.returnUrl);

  try {
    const response = await fetch(new URL('/api/google-connect?action=exchange', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri: callbackUrl(request), brand: saved.brand, ...guardFor(request) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const refused = await refusal(response);
    if (refused) return finish(request, 'inuse', saved.brand, saved.returnUrl, refused.heldBy);
    if (response.status === 422) return finish(request, 'nolocation', saved.brand, saved.returnUrl);
    if (!response.ok) {
      console.error(`google-connect answered ${response.status}`);
      return finish(request, 'failed', saved.brand, saved.returnUrl);
    }
    const body = (await response.json().catch(() => null)) as { status?: unknown; sealed?: unknown } | null;
    if (body?.status === 'saved') return finish(request, 'connected', saved.brand, saved.returnUrl);
    if (body?.status === 'pick' && typeof body.sealed === 'string') return choose(request, saved.brand, body.sealed, saved.returnUrl);
    return finish(request, 'failed', saved.brand, saved.returnUrl);
  } catch (error) {
    console.error(describeError(error));
    return finish(request, 'failed', undefined, saved.returnUrl);
  }
}
