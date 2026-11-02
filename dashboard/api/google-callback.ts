/**
 * GET /api/google-callback?code=...&state=...
 * Where Google sends the person back. The state must match the cookie set when they left. The one-time code goes
 * to the publisher, which swaps it for a refresh token and stores it encrypted. With one location it is saved at
 * once; with several, the dashboard asks which one (the sealed token waits in a hidden cookie).
 */
import { describeError } from '../lib/http.js';
import { statesMatch } from '../lib/facebook-flow.js';
import { callbackUrl, clearedConnectCookie, GOOGLE_COOKIE, parseConnectCookie, pickCookie } from '../lib/google-flow.js';
import { isSignedIn, readCookie } from '../lib/security.js';

const TIMEOUT_MS = 25_000;

type Outcome = 'connected' | 'choose' | 'denied' | 'failed' | 'nolocation';

function back(request: Request, outcome: Outcome, brand?: string, extraCookie?: string): Response {
  const where = brand ? `#/client/${brand}/channels` : '';
  const headers = new Headers({ Location: new URL(`/?google=${outcome}${where}`, request.url).toString(), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearedConnectCookie());
  if (extraCookie) headers.append('Set-Cookie', extraCookie);
  return new Response(null, { status: 302, headers });
}

export async function GET(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return Response.redirect(new URL('/login', request.url), 302);

  const params = new URL(request.url).searchParams;
  if (params.get('error')) return back(request, 'denied');

  const saved = parseConnectCookie(readCookie(request.headers.get('cookie'), GOOGLE_COOKIE));
  const code = params.get('code');
  if (!saved || !code || !statesMatch(params.get('state'), saved.state)) return back(request, 'failed');

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return back(request, 'failed');

  try {
    const response = await fetch(new URL('/api/google-connect?action=exchange', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri: callbackUrl(request), brand: saved.brand }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 422) return back(request, 'nolocation', saved.brand);
    if (!response.ok) {
      console.error(`google-connect answered ${response.status}`);
      return back(request, 'failed', saved.brand);
    }
    const body = (await response.json().catch(() => null)) as { status?: unknown; sealed?: unknown } | null;
    if (body?.status === 'saved') return back(request, 'connected', saved.brand);
    if (body?.status === 'pick' && typeof body.sealed === 'string') return back(request, 'choose', saved.brand, pickCookie(saved.brand, body.sealed));
    return back(request, 'failed', saved.brand);
  } catch (error) {
    console.error(describeError(error));
    return back(request, 'failed');
  }
}
