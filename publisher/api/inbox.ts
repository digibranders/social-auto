/**
 * The inbox for the team's dashboard (the dashboard's server adds the secrets; the browser never sees them).
 *
 * GET  /api/inbox?brand=<client id>[&status=todo|done|all][&channel=][&assignee=<name>|none]   (Authorization: Bearer $STATUS_SECRET)
 *      {"enabled", "items": [...], "counts": {"todo","done","unread"}, "channels": [...], "checkedAt"}
 * POST /api/inbox   (Authorization: Bearer $EDIT_SECRET)
 *      {"id", "action": "reply" | "done" | "reopen" | "read" | "assign" | "note", "text"?, "assignee"?, "by": "<who>"}
 *      A reply is posted to Instagram or Facebook as the account, then recorded. Nothing is sent by a timer.
 */
import { describeError, isAuthorized, json } from '../lib/http.js';
import { doInbox, inboxEnabled, listInbox, type InboxCommand } from '../lib/inbox-service.js';
import { EditError } from '../lib/overrides.js';
import { storeConfigured } from '../lib/store.js';

const BRAND = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;
const ACTIONS = ['reply', 'done', 'reopen', 'read', 'assign', 'note'] as const;
const MAX_BODY = 8 * 1024;

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['STATUS_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  const params = new URL(request.url).searchParams;
  const brand = params.get('brand') ?? '';
  if (!BRAND.test(brand)) return json(400, { error: 'brand is required' });
  const status = params.get('status');
  if (status !== null && status !== 'todo' && status !== 'done' && status !== 'all') return json(400, { error: 'status must be todo, done or all' });
  try {
    const view = await listInbox({ brand, ...(status ? { status } : {}), ...(params.get('channel') ? { channel: params.get('channel') as string } : {}), ...(params.get('assignee') ? { assignee: params.get('assignee') as string } : {}) });
    return json(200, { ...view });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'could not read the inbox' });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!inboxEnabled()) return json(503, { error: 'the inbox is switched off' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return json(413, { error: 'request too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return json(400, { error: 'send JSON' });
  const action = ACTIONS.find((a) => a === body['action']);
  if (!action || typeof body['id'] !== 'string' || typeof body['by'] !== 'string') return json(400, { error: 'id, action and by are required' });
  const command = (action === 'reply' || action === 'note' ? { id: body['id'], action, text: body['text'] } : action === 'assign' ? { id: body['id'], action, assignee: body['assignee'] ?? null } : { id: body['id'], action }) as InboxCommand;
  try {
    await doInbox(command, body['by'], Date.now());
    return json(200, { ok: true });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'the change could not be saved' });
  }
}
