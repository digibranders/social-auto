/**
 * POST /api/login  { "password": "..." }
 * Sets a signed session cookie. A wrong password is answered after a pause, which makes guessing slow.
 */
import { json } from '../lib/http.js';
import { createSession, passwordMatches, sessionCookie, SESSION_TTL_SECONDS } from '../lib/security.js';

const WRONG_PASSWORD_DELAY_MS = 1_000;
const MAX_BODY_BYTES = 1_024;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env['SESSION_SECRET'];
  const expected = process.env['DASHBOARD_PASSWORD'];
  if (!secret || !expected) return json(500, { error: 'Login is not configured' });

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'Request too large' });
  let password = '';
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === 'string') password = body.password;
  } catch {
    return json(400, { error: 'Invalid request' });
  }

  if (!passwordMatches(password, expected)) {
    await new Promise((resolve) => setTimeout(resolve, WRONG_PASSWORD_DELAY_MS));
    return json(401, { error: 'Incorrect password' });
  }
  return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(createSession(secret, Date.now()), SESSION_TTL_SECONDS) });
}
