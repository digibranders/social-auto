import { isBrand } from './facebook-flow.js';
import { siteOrigin } from './linkedin-flow.js';

/**
 * The "Connect Google" hand-off. Only a signed-in team member connects Google, with the account that manages the
 * client's listing. If that account manages several locations, the sealed, short-lived token the publisher hands
 * back waits in an HttpOnly cookie until a location is chosen; the browser's scripts can never read it.
 */
export const GOOGLE_COOKIE = 'g_connect';
export const PICK_COOKIE = 'g_pick';
const COOKIE_TTL_SECONDS = 30 * 60;
const PICK_TTL_SECONDS = 15 * 60;
const AUTHORIZE = process.env['GOOGLE_AUTHORIZE_URL'] ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/business.manage';

const secureFlag = (secure: boolean): string => (secure ? 'Secure; ' : '');
const insecure = (): boolean => process.env['COOKIE_INSECURE'] === '1';

export function connectCookie(state: string, brand: string, secure = !insecure()): string {
  return `${GOOGLE_COOKIE}=${state}.${brand}; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=${COOKIE_TTL_SECONDS}`;
}

export function clearedConnectCookie(secure = !insecure()): string {
  return `${GOOGLE_COOKIE}=; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=0`;
}

/** The state and client stored in the cookie, or null when it is missing or malformed. */
export function parseConnectCookie(value: string | undefined): { state: string; brand: string } | null {
  const match = /^([0-9a-f]{32})\.([a-z0-9][a-z0-9-]{0,40})$/.exec(value ?? '');
  return match ? { state: match[1] as string, brand: match[2] as string } : null;
}

const SEALED = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Keeps the publisher's sealed token and the client it is for in one cookie: "<client>~<sealed>". */
export function pickCookie(brand: string, sealed: string, secure = !insecure()): string {
  if (!isBrand(brand) || !SEALED.test(sealed)) throw new Error('not a valid waiting connection');
  return `${PICK_COOKIE}=${brand}~${sealed}; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=${PICK_TTL_SECONDS}`;
}

export function clearedPickCookie(secure = !insecure()): string {
  return `${PICK_COOKIE}=; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=0`;
}

export function parsePickCookie(value: string | undefined): { brand: string; sealed: string } | null {
  const [brand, sealed, ...rest] = (value ?? '').split('~');
  return rest.length === 0 && brand && sealed && isBrand(brand) && SEALED.test(sealed) ? { brand, sealed } : null;
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
