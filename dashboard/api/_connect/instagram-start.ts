/**
 * GET /api/instagram-start?invite=<link made by a product or the dashboard>   (a client connecting their own account)
 * GET /api/instagram-start?brand=<client>                                      (a signed-in team member connecting a client's account)
 * Sends the person to Instagram to approve posting for one client.
 */
import { attachInvite } from '../../lib/connect-guard.js';
import { isBrand, newState } from '../../lib/facebook-flow.js';
import { authorizeLink, callbackUrl, connectCookie } from '../../lib/instagram-flow.js';
import { verifyInvite } from '../../lib/linkedin-flow.js';
import { isSignedIn } from '../../lib/security.js';

const page = (status: number, message: string): Response =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export function GET(request: Request): Response {
  const appId = process.env['INSTAGRAM_APP_ID'];
  if (!appId) return page(503, 'Instagram is not configured');

  const params = new URL(request.url).searchParams;
  // Links made in the dashboard are signed with the session secret; links a product asks for, with INVITE_SECRET.
  const token = params.get('invite');
  const invited = verifyInvite(token, process.env['SESSION_SECRET'], Date.now()) ?? verifyInvite(token, process.env['INVITE_SECRET'], Date.now());
  let brand: string | null = invited?.brand ?? null;
  if (!brand) {
    if (params.has('invite')) return page(410, 'This link has expired or is not valid. Ask for a new one.');
    if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return Response.redirect(new URL('/login', request.url), 302);
    const asked = params.get('brand');
    if (!isBrand(asked)) return page(400, 'Invalid client');
    brand = asked;
  }

  const state = newState();
  return attachInvite(new Response(null, {
    status: 302,
    headers: {
      Location: authorizeLink({ appId, redirectUri: callbackUrl(request), state }),
      'Set-Cookie': connectCookie(state, brand, invited?.returnUrl ?? null),
      'Cache-Control': 'no-store',
    },
  }), token);
}
