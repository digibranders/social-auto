/**
 * GET /api/data: the status feed for signed-in people only.
 * The browser never sees the feed's address or secret: this function adds the secret itself.
 */
import { parseStatus } from '../shared/status.js';
import { describeError, json } from '../lib/http.js';
import { isSignedIn } from '../lib/security.js';

const FEED_TIMEOUT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });

  const feedUrl = process.env['STATUS_URL'];
  const feedSecret = process.env['STATUS_SECRET'];
  if (!feedUrl || !feedSecret) return json(500, { error: 'The status feed is not configured' });

  try {
    const response = await fetch(feedUrl, {
      headers: { Authorization: `Bearer ${feedSecret}` },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!response.ok) return json(502, { error: `The status feed answered ${response.status}` });
    return json(200, { ...parseStatus(await response.json()) });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
