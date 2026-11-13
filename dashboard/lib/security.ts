import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'cal_session';
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** A signed, expiring session token: `<payload>.<signature>`. Changing the secret signs everyone out. */
export function createSession(secret: string, nowMs: number, ttlSeconds = SESSION_TTL_SECONDS): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(nowMs / 1000) + ttlSeconds })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string | undefined, secret: string | undefined, nowMs: number): boolean {
  if (!token || !secret) return false;
  const parts = token.split('.');
  const [payload, signature] = parts;
  if (parts.length !== 2 || !payload || !signature) return false;

  const expected = Buffer.from(sign(payload, secret));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof exp === 'number' && exp * 1000 > nowMs;
  } catch {
    return false;
  }
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** `secure` is only switched off for the local development server, which runs on plain http. */
export function sessionCookie(value: string, maxAgeSeconds: number, secure = process.env['COOKIE_INSECURE'] !== '1'): string {
  return `${SESSION_COOKIE}=${value}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return sessionCookie('', 0);
}

/** Compares hashes, so the check takes the same time whatever the input. */
export function passwordMatches(input: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function isSignedIn(request: Request, secret: string | undefined, nowMs: number): boolean {
  return verifySession(readCookie(request.headers.get('cookie'), SESSION_COOKIE), secret, nowMs);
}

/**
 * Changes must come from this site's own pages. Browsers send the Origin header on every cross-site
 * write, so a request from another site (or with no Origin at all) is refused.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * For a plain HTML form on this site's own page. Every page of ours says Referrer-Policy: no-referrer, and under that
 * policy a browser sends a form post with Origin: null (or none) even from our own page. So when Origin is not an address,
 * the browser's own Sec-Fetch-Site must say the post came from this very site (a page of another site cannot fake it).
 * An Origin that names another site is never accepted.
 */
export function isSameOriginForm(request: Request): boolean {
  if (isSameOrigin(request)) return true;
  const origin = request.headers.get('origin');
  return (origin === null || origin === 'null') && request.headers.get('sec-fetch-site') === 'same-origin';
}
