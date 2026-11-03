/**
 * Hand-made posts from the dashboard. Called only by the dashboard's server (EDIT_SECRET).
 *
 * POST /api/manual?action=image                  body: the JPG file; answers {"imageKey": "..."}
 * POST /api/manual?action=create                 body: {"brand","day":"YYYY-MM-DD","caption","imageKey","channels":["instagram","linkedin:..."]}
 * POST /api/manual?action=delete&post=<id>       removes a hand-made post that has not gone out yet
 */
import { scheduleData } from '../lib/schedule-source.js';
import { allBrands } from '../lib/clients.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { removeNewPost, saveNewPost, storePicture } from '../lib/manual-service.js';
import { EditError, MAX_IMAGE_BYTES } from '../lib/overrides.js';
import { parseSchedule } from '../lib/schedule.js';
import { loadClients, storeConfigured } from '../lib/store.js';

async function addImage(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw new EditError('picture is too large', 413);
  return json(200, { imageKey: await storePicture(new Uint8Array(await request.arrayBuffer())) });
}

async function createPost(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) throw new EditError('send the post as JSON');
  const brand = body['brand'];
  const planned = new Set(parseSchedule(scheduleData).map((p) => p.brand ?? 'default'));
  const { file: added } = await loadClients();
  if (typeof brand !== 'string' || !allBrands(planned, added).has(brand)) throw new EditError('unknown client');
  // The one Instagram account belongs to the clients the content job plans for; an added client cannot use it.
  const post = await saveNewPost({ brand, day: body['day'], caption: body['caption'], imageKey: body['imageKey'], channels: body['channels'] ?? [], allowInstagram: planned.has(brand) }, Date.now());
  return json(200, { post: post.id, date: post.date });
}

async function deletePost(id: string | null): Promise<Response> {
  await removeNewPost(id, Date.now());
  return json(200, { ok: true });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });

  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  try {
    if (action === 'image') return await addImage(request);
    if (action === 'create') return await createPost(request);
    if (action === 'delete') return await deletePost(url.searchParams.get('post'));
    return json(400, { error: 'unknown action' });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save the post' });
  }
}
