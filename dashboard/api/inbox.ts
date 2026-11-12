/**
 * GET  /api/inbox?brand=&status=&channel=&assignee=   a client's messages, for signed-in people only
 * POST /api/inbox   {"id", "action", "text"?, "assignee"?, "by"}   answer, close, assign or note a message
 *
 * Signed-in people only, from this site's own pages only (writes). The publisher does the work; this function reaches it with secrets the browser never sees.
 */
import { parseInbox } from '../shared/inbox.js';
import { describeError, json } from '../lib/http.js';
import { PUBLISHING_OFF_MESSAGE, publishingEnabled } from '../lib/publishing.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

const TIMEOUT_MS = 40_000;
const MAX_BODY_BYTES = 8 * 1024;
const ACTIONS = ['reply', 'done', 'reopen', 'read', 'assign', 'note'] as const;
const ID = /^[A-Za-z0-9:._|-]{1,200}$/;

export async function GET(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  const feedUrl = process.env['STATUS_URL'];
  const secret = process.env['STATUS_SECRET'];
  if (!feedUrl || !secret) return json(500, { error: 'The status feed is not configured' });
  const params = new URL(request.url).searchParams;
  const target = new URL(feedUrl.replace(/\/status$/, '/inbox'));
  for (const name of ['brand', 'status', 'channel', 'assignee']) {
    const value = params.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }
  try {
    const response = await fetch(target, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 400) return json(400, { error: ((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Bad request' });
    if (!response.ok) return json(502, { error: `The inbox answered ${response.status}` });
    return json(200, { ...parseInbox(await response.json()) });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });
  const target = process.env['EDIT_URL'];
  const secret = process.env['EDIT_SECRET'];
  if (!target || !secret) return json(503, { error: 'The inbox is not configured' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'That is too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = ACTIONS.find((a) => a === body?.['action']);
  const text = body?.['text'];
  const assignee = body?.['assignee'];
  const by = body?.['by'];
  if (!action || typeof body?.['id'] !== 'string' || !ID.test(body['id']) || typeof by !== 'string' || !by.trim() || by.length > 80 || (text !== undefined && typeof text !== 'string') || (assignee !== undefined && assignee !== null && typeof assignee !== 'string')) return json(400, { error: 'Invalid request' });
  // A public reply is publishing: refused while the switch is off. Closing, assigning and noting change nothing on a network, so they are always allowed.
  if (action === 'reply' && !publishingEnabled()) return json(503, { error: PUBLISHING_OFF_MESSAGE });
  try {
    const response = await fetch(new URL('/api/inbox', target), {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: body['id'], action, by: by.trim(), ...(text !== undefined ? { text } : {}), ...(assignee !== undefined ? { assignee } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer: unknown = await response.json().catch(() => null);
    if (response.ok) return json(200, { ok: true });
    const message = (answer as { error?: unknown } | null)?.error;
    const known = response.status >= 400 && response.status < 500 && typeof message === 'string';
    return json(known ? response.status : 502, { error: known ? message : `The publisher answered ${response.status}` });
  } catch (error) {
    return json(502, { error: describeError(error) });
  }
}
