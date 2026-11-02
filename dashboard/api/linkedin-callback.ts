/**
 * GET /api/linkedin-callback?code=...&state=...
 * Where LinkedIn sends the person back. The state must match the cookie set when they left. The one-time code
 * goes to the publisher, which swaps it for a token and stores it encrypted. A signed-in team member returns to
 * the dashboard; a client (who has no login) sees a plain thank-you page.
 */
import { describeError } from '../lib/http.js';
import { statesMatch } from '../lib/facebook-flow.js';
import { callbackUrl, clearedConnectCookie, LINKEDIN_COOKIE, parseConnectCookie } from '../lib/linkedin-flow.js';
import { isSignedIn, readCookie } from '../lib/security.js';

const TIMEOUT_MS = 25_000;

type Outcome = 'connected' | 'denied' | 'failed';

const MESSAGES: Record<Outcome, { title: string; body: string }> = {
  connected: { title: 'You are connected', body: 'Thank you. Your LinkedIn is now linked, and posts will appear on your profile. You can close this page.' },
  denied: { title: 'Nothing was connected', body: 'You chose not to allow it, so nothing was linked. If that was a mistake, open the link again and press Allow.' },
  failed: { title: 'That did not work', body: 'The connection could not be completed. Please open the link again and press Allow. If it keeps failing, tell the person who sent it.' },
};

function finish(request: Request, outcome: Outcome, brand?: string): Response {
  const headers = { 'Set-Cookie': clearedConnectCookie(), 'Cache-Control': 'no-store' };
  if (isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) {
    const where = brand ? `#/client/${brand}/channels` : '';
    return new Response(null, { status: 302, headers: { ...headers, Location: new URL(`/?linkedin=${outcome}${where}`, request.url).toString() } });
  }
  const { title, body } = MESSAGES[outcome];
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="color-scheme" content="light dark" />
    <title>${title}</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body class="login-page">
    <main class="login">
      <h1>${title}</h1>
      <p class="muted">${body}</p>
    </main>
  </body>
</html>
`;
  return new Response(html, { status: outcome === 'failed' ? 400 : 200, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  if (params.get('error')) return finish(request, 'denied');

  const saved = parseConnectCookie(readCookie(request.headers.get('cookie'), LINKEDIN_COOKIE));
  const code = params.get('code');
  if (!saved || !code || !statesMatch(params.get('state'), saved.state)) return finish(request, 'failed');

  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return finish(request, 'failed');

  try {
    const response = await fetch(new URL('/api/linkedin-connect', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri: callbackUrl(request), brand: saved.brand }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) console.error(`linkedin-connect answered ${response.status}`);
    return finish(request, response.ok ? 'connected' : 'failed', saved.brand);
  } catch (error) {
    console.error(describeError(error));
    return finish(request, 'failed');
  }
}
