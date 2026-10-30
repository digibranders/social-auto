/**
 * Disconnects a channel. Called only by the dashboard's server (EDIT_SECRET).
 *
 * POST /api/channels   {"remove": "facebook:<page id>"}
 */
import { removeChannel } from '../lib/channels.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { loadChannels, saveChannels, storeConfigured } from '../lib/store.js';

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  const body = (await request.json().catch(() => null)) as { remove?: unknown } | null;
  if (typeof body?.remove !== 'string' || !body.remove) return json(400, { error: 'remove is required' });
  try {
    const { file, etag } = await loadChannels();
    if (!file.channels.some((c) => c.id === body.remove)) return json(404, { error: 'no such channel' });
    await saveChannels(removeChannel(file, body.remove), etag);
    return json(200, { ok: true });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'could not disconnect' });
  }
}
