/**
 * GET /api/linkedin-start?invite=<link made in the dashboard>   (a client connecting their own profile)
 * GET /api/linkedin-start?brand=<client>                         (a signed-in team member connecting their own)
 * Sends the person to LinkedIn to approve posting for one client.
 */
import { isBrand, newState } from '../lib/facebook-flow.js';
import { authorizeLink, callbackUrl, connectCookie, verifyInvite } from '../lib/linkedin-flow.js';
import { isSignedIn } from '../lib/security.js';

const page = (status: number, message: string): Response =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export function GET(request: Request): Response {
  const clientId = process.env['LINKEDIN_CLIENT_ID'];
  if (!clientId) return page(503, 'LinkedIn is not configured');

  const params = new URL(request.url).searchParams;
  const invited = verifyInvite(params.get('invite'), process.env['SESSION_SECRET'], Date.now());
  let brand: string | null = invited;
  if (!brand) {
    if (params.has('invite')) return page(410, 'This link has expired or is not valid. Ask for a new one.');
    if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return Response.redirect(new URL('/login', request.url), 302);
    const asked = params.get('brand');
    if (!isBrand(asked)) return page(400, 'Invalid client');
    brand = asked;
  }

  const state = newState();
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeLink({ clientId, redirectUri: callbackUrl(request), state }),
      'Set-Cookie': connectCookie(state, brand),
      'Cache-Control': 'no-store',
    },
  });
}
