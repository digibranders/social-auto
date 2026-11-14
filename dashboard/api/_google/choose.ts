/**
 * GET  /api/google/choose   a plain page with one button per location the Google account manages
 * POST /api/google/choose   saves the location that was pressed (a form post: location=<id>)
 * For a client with no login, right after Google sends them back. It works only with the hidden cookie holding the
 * sealed, short-lived token that Google sign-in left, so it cannot be used to connect anything else.
 */
import { guardFor } from '../../lib/connect-guard.js';
import { describeError } from '../../lib/http.js';
import { finishConnect, type Outcome } from '../../lib/connect-result.js';
import { chooserPage } from '../../lib/google-choose.js';
import { clearedPickCookie, parsePickCookie, PICK_COOKIE } from '../../lib/google-flow.js';
import { askPublisher, parseChoices } from '../../lib/google-publisher.js';
import { isSameOriginForm, readCookie } from '../../lib/security.js';

const LOCATION_ID = /^\d{1,25}$/;
const html = (status: number, body: string, extra: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });

const waiting = (request: Request): { brand: string; sealed: string; returnUrl: string | null } | null => parsePickCookie(readCookie(request.headers.get('cookie'), PICK_COOKIE));
const expired = (request: Request): Response => finishConnect({ request, platform: 'google', outcome: 'expired', clearCookie: clearedPickCookie() });
const done = (request: Request, pending: { brand: string; returnUrl: string | null }, outcome: Outcome, withBrand = true, heldBy?: string): Response =>
  finishConnect({ request, platform: 'google', outcome, clearCookie: clearedPickCookie(), ...(withBrand ? { brand: pending.brand } : {}), returnUrl: pending.returnUrl, ...(heldBy ? { heldBy } : {}) });

export async function GET(request: Request): Promise<Response> {
  const pending = waiting(request);
  if (!pending) return expired(request);
  try {
    const { status, body } = await askPublisher('locations', { sealed: pending.sealed, brand: pending.brand });
    if (status === 410) return expired(request);
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
    const { status, body } = await askPublisher('save', { sealed: pending.sealed, brand: pending.brand, location, ...guardFor(request) });
    if (status === 410) return expired(request);
    if (status === 409 && body?.['code'] === 'ACCOUNT_IN_USE') return done(request, pending, 'inuse', true, typeof body['heldBy'] === 'string' ? body['heldBy'] : undefined);
    if (status !== 200) console.error(`google-connect save answered ${status}`);
    return done(request, pending, status === 200 ? 'connected' : 'failed');
  } catch (error) {
    console.error(describeError(error));
    return done(request, pending, 'failed', false);
  }
}
