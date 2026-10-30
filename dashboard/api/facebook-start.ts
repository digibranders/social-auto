/**
 * GET /api/facebook-start?brand=<client>
 * Sends a signed-in person to Facebook to approve the Pages for one client.
 */
import { authorizeLink, callbackUrl, connectCookie, isBrand, newState } from '../lib/facebook-flow.js';
import { isSignedIn } from '../lib/security.js';

export function GET(request: Request): Response {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return Response.redirect(new URL('/login', request.url), 302);

  const appId = process.env['FACEBOOK_APP_ID'];
  if (!appId) return new Response('Facebook is not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const brand = new URL(request.url).searchParams.get('brand');
  if (!isBrand(brand)) return new Response('Invalid client', { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const state = newState();
  const configId = process.env['FACEBOOK_CONFIG_ID'];
  const link = authorizeLink({ appId, redirectUri: callbackUrl(request), state, ...(configId ? { configId } : {}) });
  return new Response(null, {
    status: 302,
    headers: { Location: link, 'Set-Cookie': connectCookie(state, brand), 'Cache-Control': 'no-store' },
  });
}
