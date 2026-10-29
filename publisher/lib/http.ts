import { timingSafeEqual } from 'node:crypto';

export function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

/** Cron endpoints are only callable with the shared secret, sent as a Bearer token. */
export function isAuthorized(request: Request, secret = process.env['CRON_SECRET']): boolean {
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
