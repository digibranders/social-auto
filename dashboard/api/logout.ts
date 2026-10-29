/** POST /api/logout: clears the session cookie. */
import { json } from '../lib/http.js';
import { clearedSessionCookie } from '../lib/security.js';

export function POST(): Response {
  return json(200, { ok: true }, { 'Set-Cookie': clearedSessionCookie() });
}
