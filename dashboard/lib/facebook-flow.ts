import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The "Connect Facebook" hand-off. The dashboard sends the person to Facebook with a random state and keeps
 * the same state (and the client being connected) in a short-lived cookie; on the way back the two must match.
 */
export const CONNECT_COOKIE = 'fb_connect';
const CONNECT_TTL_SECONDS = 30 * 60;
const BRAND = /^[a-z0-9][a-z0-9-]{0,40}$/;

export const isBrand = (value: string | null): value is string => value !== null && BRAND.test(value);

/** An address a person may be sent back to: https, or http only for the local machine. */
export function isSafeReturnUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

export function newState(): string {
  return randomBytes(16).toString('hex');
}

export function connectCookie(state: string, brand: string, returnUrl: string | null = null, secure = process.env['COOKIE_INSECURE'] !== '1'): string {
  const tail = returnUrl ? `.${Buffer.from(returnUrl).toString('base64url')}` : '';
  return `${CONNECT_COOKIE}=${state}.${brand}${tail}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/api; Max-Age=${CONNECT_TTL_SECONDS}`;
}

export function clearedConnectCookie(secure = process.env['COOKIE_INSECURE'] !== '1'): string {
  return `${CONNECT_COOKIE}=; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/api; Max-Age=0`;
}

/** The state, client and (for a person sent by a product) the address to return to, or null when missing or malformed. */
export function parseConnectCookie(value: string | undefined): { state: string; brand: string; returnUrl: string | null } | null {
  const match = /^([0-9a-f]{32})\.([a-z0-9][a-z0-9-]{0,40})(?:\.([A-Za-z0-9_-]{1,700}))?$/.exec(value ?? '');
  if (!match) return null;
  const returnUrl = match[3] ? Buffer.from(match[3], 'base64url').toString('utf8') : null;
  if (returnUrl !== null && !isSafeReturnUrl(returnUrl)) return null;
  return { state: match[1] as string, brand: match[2] as string, returnUrl };
}

export function statesMatch(a: string | null, b: string): boolean {
  const left = Buffer.from(a ?? '');
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Where Facebook sends the person back to: this site's callback, on whatever address the request came to. */
export function callbackUrl(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0] ?? url.protocol.replace(':', '');
  return `${protocol}://${host}/api/facebook-callback`;
}

export function authorizeLink(options: { appId: string; redirectUri: string; state: string; configId?: string }): string {
  const params = new URLSearchParams({
    client_id: options.appId,
    redirect_uri: options.redirectUri,
    state: options.state,
    response_type: 'code',
  });
  if (options.configId) params.set('config_id', options.configId);
  else params.set('scope', 'pages_show_list,pages_manage_posts,pages_read_engagement');
  return `${process.env['FACEBOOK_DIALOG_URL'] ?? 'https://www.facebook.com/v23.0/dialog/oauth'}?${params}`;
}
