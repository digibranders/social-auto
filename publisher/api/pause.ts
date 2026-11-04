/**
 * Pausing and resuming, from the dashboard. Called only by the dashboard's server, with its own secret (EDIT_SECRET).
 *
 * POST /api/pause   {"scope": "all" | "brand" | "channel", "id"?: "<client or channel id>", "paused": true | false}
 *                   holds back (or lets go again) everything, one client, or one channel; nothing is deleted
 * GET  /api/pause   what is paused now
 */
import { describeError, isAuthorized, json } from '../lib/http.js';
import { EditError } from '../lib/overrides.js';
import { setPause, type PauseScope } from '../lib/pauses.js';
import { loadPauses, savePauses, storeConfigured } from '../lib/store.js';

const SCOPES: readonly PauseScope[] = ['all', 'brand', 'channel'];

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  try {
    return json(200, { pauses: (await loadPauses()).file });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'could not read the pauses' });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > 2 * 1024) return json(413, { error: 'request too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return json(400, { error: 'send JSON' });
  const scope = SCOPES.find((s) => s === body['scope']);
  if (!scope) return json(400, { error: `scope must be one of: ${SCOPES.join(', ')}` });
  if (typeof body['paused'] !== 'boolean') return json(400, { error: 'paused must be true or false' });
  try {
    const { file, etag } = await loadPauses();
    const next = setPause(file, scope, body['id'], body['paused']);
    await savePauses(next, etag);
    return json(200, { pauses: next });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    if (error instanceof Error && /^that is not a/.test(error.message)) return json(400, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save the pause' });
  }
}
