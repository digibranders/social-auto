/**
 * GET  /api/google/choose   a plain page with one button per location the Google account manages
 * POST /api/google/choose   saves the location that was pressed (a form post: location=<id>)
 * For a client with no login, right after Google sends them back. It works only with the hidden cookie holding the
 * sealed, short-lived token that Google sign-in left, so it cannot be used to connect anything else.
 */
import { describeError } from '../../lib/http.js';
import { finishConnect, type Outcome } from '../../lib/connect-result.js';
import { chooserPage } from '../../lib/google-choose.js';
import { clearedPickCookie, DONE_COOKIE, doneCookie, parseDoneCookie, parsePickCookie, PICK_COOKIE } from '../../lib/google-flow.js';
import { askPublisher, parseChoices } from '../../lib/google-publisher.js';
import { isSameOriginForm, readCookie } from '../../lib/security.js';

const LOCATION_ID = /^\d{1,25}$/;
const html = (status: number, body: string, extra: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

const waiting = (request: Request): { brand: string; sealed: string; returnUrl: string | null } | null => parsePickCookie(readCookie(request.headers.get('cookie'), PICK_COOKIE));
/**
 * Nothing is waiting (or what waited ran out). Right after a choice was made that is usually a second press or the Back button, so say what the
 * first choice did (and send a person sent by a product back to it); only otherwise is the link out of time. `returnUrl` is where a product's
 * customer goes back to when the waiting connection is known but too old.
 */
const expired = (request: Request, returnUrl: string | null = null): Response => {
  const earlier = parseDoneCookie(readCookie(request.headers.get('cookie'), DONE_COOKIE));
  if (earlier) return finishConnect({ request, platform: 'google', outcome: earlier.outcome, clearCookie: clearedPickCookie(), returnUrl: earlier.returnUrl });
  return finishConnect({ request, platform: 'google', outcome: 'expired', clearCookie: clearedPickCookie(), returnUrl });
};
const done = (request: Request, pending: { brand: string; returnUrl: string | null }, outcome: Outcome, withBrand = true): Response =>
  finishConnect({ request, platform: 'google', outcome, clearCookie: clearedPickCookie(), extraCookies: [doneCookie(outcome, pending.returnUrl)], ...(withBrand ? { brand: pending.brand } : {}), returnUrl: pending.returnUrl });

export async function GET(request: Request): Promise<Response> {
  const pending = waiting(request);
  if (!pending) return expired(request);
  try {
    const { status, body } = await askPublisher('locations', { sealed: pending.sealed, brand: pending.brand });
    if (status === 410) return expired(request, pending.returnUrl);
    const choices = status === 200 ? parseChoices(body) : null;
    if (!choices || choices.length === 0) return done(request, pending, choices ? 'nolocation' : 'failed');
    return html(200, chooserPage(choices));
  } catch (error) {
    console.error(describeError(error));
    return done(request, pending, 'failed', false);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginForm(request)) return html(403, 'Request not allowed');
  const pending = waiting(request);
  if (!pending) return expired(request);
  const location = new URLSearchParams(await request.text().catch(() => '')).get('location') ?? '';
  if (!LOCATION_ID.test(location)) return html(400, 'Invalid location');
  try {
    const { status } = await askPublisher('save', { sealed: pending.sealed, brand: pending.brand, location });
    if (status === 410) return expired(request, pending.returnUrl);
    if (status !== 200) console.error(`google-connect save answered ${status}`);
    return done(request, pending, status === 200 ? 'connected' : 'failed');
  } catch (error) {
    console.error(describeError(error));
    return done(request, pending, 'failed', false);
  }
}
