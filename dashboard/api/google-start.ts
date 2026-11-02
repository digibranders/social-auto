/**
 * GET /api/google-start?brand=<client>
 * Sends a signed-in person to Google to approve posting for one client's business listing.
 */
import { isBrand, newState } from '../lib/facebook-flow.js';
import { authorizeLink, callbackUrl, connectCookie } from '../lib/google-flow.js';
import { isSignedIn } from '../lib/security.js';

export function GET(request: Request): Response {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return Response.redirect(new URL('/login', request.url), 302);

  const clientId = process.env['GOOGLE_CLIENT_ID'];
  if (!clientId) return new Response('Google is not configured', { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const brand = new URL(request.url).searchParams.get('brand');
  if (!isBrand(brand)) return new Response('Invalid client', { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const state = newState();
  return new Response(null, {
    status: 302,
    headers: { Location: authorizeLink({ clientId, redirectUri: callbackUrl(request), state }), 'Set-Cookie': connectCookie(state, brand), 'Cache-Control': 'no-store' },
  });
}
