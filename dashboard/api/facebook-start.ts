/**
 * GET /api/facebook-start?brand=<client>                         (a signed-in team member connecting a client's Pages)
 * GET /api/facebook-start?invite=<link made by a product or the dashboard>   (a customer connecting their own Pages)
 * Sends the person to Facebook to approve the Pages for one client.
 */
import { authorizeLink, callbackUrl, connectCookie, isBrand, newState } from '../lib/facebook-flow.js';
import { verifyInvite } from '../lib/linkedin-flow.js';
import { isSignedIn } from '../lib/security.js';

const page = (status: number, message: string): Response =>
  new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

export function GET(request: Request): Response {
  const appId = process.env['FACEBOOK_APP_ID'];
  if (!appId) return page(503, 'Facebook is not configured');

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
  const configId = process.env['FACEBOOK_CONFIG_ID'];
  const link = authorizeLink({ appId, redirectUri: callbackUrl(request), state, ...(configId ? { configId } : {}) });
  return new Response(null, {
    status: 302,
    headers: { Location: link, 'Set-Cookie': connectCookie(state, brand, invited?.returnUrl ?? null), 'Cache-Control': 'no-store' },
  });
}
