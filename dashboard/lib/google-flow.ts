import { isBrand, isSafeReturnUrl } from './facebook-flow.js';
import { siteOrigin } from './linkedin-flow.js';

/**
 * The "Connect Google" hand-off. Only a signed-in team member connects Google, with the account that manages the
 * client's listing. If that account manages several locations, the sealed, short-lived token the publisher hands
 * back waits in an HttpOnly cookie until a location is chosen; the browser's scripts can never read it.
 */
export const GOOGLE_COOKIE = 'g_connect';
export const PICK_COOKIE = 'g_pick';
export const DONE_COOKIE = 'g_done';
const COOKIE_TTL_SECONDS = 30 * 60;
const PICK_TTL_SECONDS = 15 * 60;
/** How long what a finished choice did is remembered, so a second press or the Back button says the same thing again. */
const DONE_TTL_SECONDS = 5 * 60;
const AUTHORIZE = process.env['GOOGLE_AUTHORIZE_URL'] ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/business.manage';

const secureFlag = (secure: boolean): string => (secure ? 'Secure; ' : '');
const insecure = (): boolean => process.env['COOKIE_INSECURE'] === '1';

/** A returnUrl travels in the cookies as base64url, so it can never contain the characters the cookies are split on. */
const encodeReturn = (returnUrl: string | null): string => (returnUrl ? Buffer.from(returnUrl).toString('base64url') : '');
const RETURN_TAIL = '[A-Za-z0-9_-]{1,700}';

function decodeReturn(encoded: string | undefined): string | null | undefined {
  if (!encoded) return null;
  const url = Buffer.from(encoded, 'base64url').toString('utf8');
  // A return address that is not a safe one makes the whole cookie unusable, never a redirect somewhere else.
  return isSafeReturnUrl(url) ? url : undefined;
}

export function connectCookie(state: string, brand: string, returnUrl: string | null = null, secure = !insecure()): string {
  const tail = returnUrl ? `.${encodeReturn(returnUrl)}` : '';
  return `${GOOGLE_COOKIE}=${state}.${brand}${tail}; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=${COOKIE_TTL_SECONDS}`;
}

export function clearedConnectCookie(secure = !insecure()): string {
  return `${GOOGLE_COOKIE}=; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=0`;
}

/** The state, client and (for a person sent by a product) the address to return to, or null when missing or malformed. */
export function parseConnectCookie(value: string | undefined): { state: string; brand: string; returnUrl: string | null } | null {
  const match = new RegExp(`^([0-9a-f]{32})\\.([a-z0-9][a-z0-9-]{0,40})(?:\\.(${RETURN_TAIL}))?$`).exec(value ?? '');
  if (!match) return null;
  const returnUrl = decodeReturn(match[3]);
  return returnUrl === undefined ? null : { state: match[1] as string, brand: match[2] as string, returnUrl };
}

const SEALED = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Keeps the publisher's sealed token, the client it is for and (for a person sent by a product) where to return, in one cookie: "<client>~<sealed>[~<return>]". */
export function pickCookie(brand: string, sealed: string, returnUrl: string | null = null, secure = !insecure()): string {
  if (!isBrand(brand) || !SEALED.test(sealed)) throw new Error('not a valid waiting connection');
  if (returnUrl !== null && !isSafeReturnUrl(returnUrl)) throw new Error('not a valid return address');
  const tail = returnUrl ? `~${encodeReturn(returnUrl)}` : '';
  return `${PICK_COOKIE}=${brand}~${sealed}${tail}; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=${PICK_TTL_SECONDS}`;
}

export function clearedPickCookie(secure = !insecure()): string {
  return `${PICK_COOKIE}=; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=0`;
}

export function parsePickCookie(value: string | undefined): { brand: string; sealed: string; returnUrl: string | null } | null {
  const [brand, sealed, encoded, ...rest] = (value ?? '').split('~');
  if (rest.length > 0 || !brand || !sealed || !isBrand(brand) || !SEALED.test(sealed)) return null;
  if (encoded !== undefined && !new RegExp(`^${RETURN_TAIL}$`).test(encoded)) return null;
  const returnUrl = decodeReturn(encoded);
  return returnUrl === undefined ? null : { brand, sealed, returnUrl };
}

/** Where Google sends the person back to. It must match, exactly, an address saved on the Google OAuth client. */
export const callbackUrl = (request: Request): string => `${siteOrigin(request)}/api/google/callback`;

export function authorizeLink(options: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    scope: SCOPE,
    // Offline access and a fresh consent are what make Google hand back a refresh token.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTHORIZE}?${params}`;
}

export type DoneOutcome = 'connected' | 'denied' | 'failed' | 'expired' | 'nolocation' | 'inuse';
const DONE_OUTCOMES: readonly string[] = ['connected', 'denied', 'failed', 'expired', 'nolocation', 'inuse'];

/**
 * What the choice just did, kept for a few minutes: "<outcome>[.<return>]". The choice clears the waiting connection, so a second press of a
 * listing (a double click) or the Back button finds nothing waiting. This tells that person what the first press did, and sends a person
 * sent by a product back to it, instead of an error page on this site.
 */
export function doneCookie(outcome: DoneOutcome, returnUrl: string | null = null, secure = !insecure()): string {
  if (returnUrl !== null && !isSafeReturnUrl(returnUrl)) throw new Error('not a valid return address');
  const tail = returnUrl ? `.${encodeReturn(returnUrl)}` : '';
  return `${DONE_COOKIE}=${outcome}${tail}; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=${DONE_TTL_SECONDS}`;
}

export function clearedDoneCookie(secure = !insecure()): string {
  return `${DONE_COOKIE}=; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=0`;
}

export function parseDoneCookie(value: string | undefined): { outcome: DoneOutcome; returnUrl: string | null } | null {
  const match = new RegExp(`^([a-z]+)(?:\\.(${RETURN_TAIL}))?$`).exec(value ?? '');
  if (!match || !DONE_OUTCOMES.includes(match[1] as string)) return null;
  const returnUrl = decodeReturn(match[2]);
  return returnUrl === undefined ? null : { outcome: match[1] as DoneOutcome, returnUrl };
}
