/**
 * GET /api/linkedin-callback?code=...&state=...
 * Where LinkedIn sends the person back. The state must match the cookie set when they left. The one-time code
 * goes to the publisher, which swaps it for a token and stores it encrypted. Where the person lands afterwards
 * is decided in lib/connect-result.ts.
 */
import { describeError } from '../lib/http.js';
import { statesMatch } from '../lib/facebook-flow.js';
import { callbackUrl, clearedConnectCookie, LINKEDIN_COOKIE, parseConnectCookie } from '../lib/linkedin-flow.js';
import { finishConnect, type Outcome } from '../lib/connect-result.js';
import { readCookie } from '../lib/security.js';

const TIMEOUT_MS = 25_000;

const finish = (request: Request, outcome: Outcome, brand?: string, returnUrl: string | null = null): Response =>
  finishConnect({ request, platform: 'linkedin', outcome, clearCookie: clearedConnectCookie(), ...(brand ? { brand } : {}), returnUrl });

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const saved = parseConnectCookie(readCookie(request.headers.get('cookie'), LINKEDIN_COOKIE));
  if (params.get('error')) return finish(request, 'denied', undefined, saved?.returnUrl ?? null);
  const code = params.get('code');
  if (!saved || !code || !statesMatch(params.get('state'), saved.state)) return finish(request, 'failed', undefined, saved?.returnUrl ?? null);

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return finish(request, 'failed', undefined, saved.returnUrl);

  try {
    const response = await fetch(new URL('/api/linkedin-connect', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri: callbackUrl(request), brand: saved.brand }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.error(`linkedin-connect answered ${response.status}`);
    return finish(request, response.ok ? 'connected' : 'failed', saved.brand, saved.returnUrl);
  } catch (error) {
    console.error(describeError(error));
    return finish(request, 'failed', undefined, saved.returnUrl);
  }
}
