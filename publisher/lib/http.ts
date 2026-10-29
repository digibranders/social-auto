import { timingSafeEqual } from 'node:crypto';

/** JSON response that browsers and CDNs must never cache. */
export function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

/**
 * Private endpoints are only callable with their own shared secret, sent as a Bearer token.
 * The secret is an explicit argument so an unset variable can never fall back to another endpoint's secret.
 */
export function isAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
