import { createHmac, timingSafeEqual } from 'node:crypto';
import { isBrand, isSafeReturnUrl } from './facebook-flow.js';

export { isSafeReturnUrl };

/**
 * The "Connect LinkedIn" hand-off. Unlike Facebook, the person who presses Allow is usually the client, who has
 * no login here, so a signed-in team member makes a short-lived invite link for one client. The link only starts
 * the approval for that client; it cannot read or change anything.
 */
export const LINKEDIN_COOKIE = 'li_connect';
const COOKIE_TTL_SECONDS = 30 * 60;
export const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
const AUTHORIZE = process.env['LINKEDIN_AUTHORIZE_URL'] ?? 'https://www.linkedin.com/oauth/v2/authorization';
const SCOPE = 'openid profile w_member_social';

/** Signed with a purpose prefix, so a session token can never pass as an invite or the reverse. */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`linkedin-invite.${payload}`).digest('base64url');
}

export function createInvite(secret: string, brand: string, nowMs: number, ttlSeconds = INVITE_TTL_SECONDS, returnUrl?: string, moveFrom?: string): string {
  const payload = Buffer.from(JSON.stringify({ b: brand, e: Math.floor(nowMs / 1000) + ttlSeconds, ...(returnUrl ? { r: returnUrl } : {}), ...(moveFrom ? { m: moveFrom } : {}) })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export interface Invite {
  brand: string;
  /** Where to send the person afterwards (a product's own page); missing means show our thank-you page. */
  returnUrl: string | null;
  /** For a customer's own link made by a product: the one brand she agreed to take an account from. */
  moveFrom: string | null;
}

/** The client an invite is for (and where to return to), or null when it is forged, malformed or past its date. */
export function verifyInvite(token: string | null, secret: string | undefined, nowMs: number): Invite | null {
  if (!token || !secret) return null;
  const parts = token.split('.');
  const [payload, signature] = parts;
  if (parts.length !== 2 || !payload || !signature) return null;
  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const { b, e, r, m } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { b?: unknown; e?: unknown; r?: unknown; m?: unknown };
    if (typeof b !== 'string' || !isBrand(b) || typeof e !== 'number' || e * 1000 <= nowMs) return null;
    if (r !== undefined && !isSafeReturnUrl(r)) return null;
    return { brand: b, returnUrl: r ?? null, moveFrom: typeof m === 'string' && m ? m : null };
  } catch {
    return null;
  }
}

export function connectCookie(state: string, brand: string, returnUrl: string | null = null, secure = process.env['COOKIE_INSECURE'] !== '1'): string {
  const tail = returnUrl ? `.${Buffer.from(returnUrl).toString('base64url')}` : '';
  return `${LINKEDIN_COOKIE}=${state}.${brand}${tail}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/api; Max-Age=${COOKIE_TTL_SECONDS}`;
}

export function clearedConnectCookie(secure = process.env['COOKIE_INSECURE'] !== '1'): string {
  return `${LINKEDIN_COOKIE}=; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/api; Max-Age=0`;
}

/** The state and client stored in the cookie, or null when it is missing or malformed. */
export function parseConnectCookie(value: string | undefined): { state: string; brand: string; returnUrl: string | null } | null {
  const match = /^([0-9a-f]{32})\.([a-z0-9][a-z0-9-]{0,40})(?:\.([A-Za-z0-9_-]{1,700}))?$/.exec(value ?? '');
  if (!match) return null;
  const returnUrl = match[3] ? Buffer.from(match[3], 'base64url').toString('utf8') : null;
  if (returnUrl !== null && !isSafeReturnUrl(returnUrl)) return null;
  return { state: match[1] as string, brand: match[2] as string, returnUrl };
}

/** The address of this site as the person's browser sees it, also when it sits behind a proxy. */
export function siteOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0] ?? url.protocol.replace(':', '');
  return `${protocol}://${host}`;
}

/** Where LinkedIn sends the person back to. It must match, exactly, an address saved in the LinkedIn app. */
export const callbackUrl = (request: Request): string => `${siteOrigin(request)}/api/linkedin-callback`;

export function authorizeLink(options: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    scope: SCOPE,
  });
  return `${AUTHORIZE}?${params}`;
}
