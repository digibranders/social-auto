/**
 * GET /api/analytics?brand=&from=&to=: a client's analytics for signed-in people only.
 * The browser never sees the publisher's address or secret: this function adds the secret itself.
 */
import { parseAnalytics } from '../shared/analytics.js';
import { describeError, json } from '../lib/http.js';
import { isSignedIn } from '../lib/security.js';

const TIMEOUT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  const feedUrl = process.env['STATUS_URL'];
  const secret = process.env['STATUS_SECRET'];
  if (!feedUrl || !secret) return json(500, { error: 'The status feed is not configured' });
  const params = new URL(request.url).searchParams;
  const target = new URL(feedUrl.replace(/\/status$/, '/analytics'));
  for (const name of ['brand', 'from', 'to']) {
    const value = params.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }
  try {
    const response = await fetch(target, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 400) return json(400, { error: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Bad request' });
    if (!response.ok) return json(502, { error: `The analytics feed answered ${response.status}` });
    return json(200, { ...parseAnalytics(await response.json()) });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
