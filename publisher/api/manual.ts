/**
 * Hand-made posts from the dashboard. Called only by the dashboard's server (EDIT_SECRET).
 *
 * POST /api/manual?action=image                  body: the JPG file; answers {"imageKey": "..."}
 * POST /api/manual?action=create                 body: {"brand","day":"YYYY-MM-DD","caption","imageKey","channels":["instagram","linkedin:..."]}
 * POST /api/manual?action=delete&post=<id>       removes a hand-made post that has not gone out yet
 */
import { randomBytes } from 'node:crypto';
import { schedule as scheduleData } from '../data/schedule.js';
import { channelsFor } from '../lib/channels.js';
import { allBrands } from '../lib/clients.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { buildManualPost, isManualId, MAX_MANUAL_POSTS, toScheduled } from '../lib/manual.js';
import { EditError, isEditable, MAX_IMAGE_BYTES, validateJpeg } from '../lib/overrides.js';
import { parseSchedule } from '../lib/schedule.js';
import { deleteImage, loadChannels, loadClients, loadImage, loadManual, loadOverrides, saveImage, saveManual, saveOverrides, storeConfigured } from '../lib/store.js';

async function imageExists(key: string): Promise<boolean> {
  const stream = await loadImage(key);
  await stream?.cancel();
  return stream !== null;
}

async function addImage(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw new EditError('picture is too large', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  validateJpeg(bytes);
  const imageKey = randomBytes(16).toString('hex');
  await saveImage(imageKey, bytes);
  return json(200, { imageKey });
}

async function createPost(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) throw new EditError('send the post as JSON');
  const brand = body['brand'];
  const planned = new Set(parseSchedule(scheduleData).map((p) => p.brand ?? 'default'));
  const [{ file: channels }, { file, etag }, { file: added }] = await Promise.all([loadChannels(), loadManual(), loadClients()]);
  if (typeof brand !== 'string' || !allBrands(planned, added).has(brand)) throw new EditError('unknown client');
  if (file.posts.length >= MAX_MANUAL_POSTS) throw new EditError('too many extra posts are stored; delete some first');
  // The one Instagram account belongs to the clients the content job plans for; an added client cannot use it.
  const allowed = [...(planned.has(brand) ? ['instagram'] : []), ...channelsFor(channels, brand).map((c) => c.id)];
  const post = buildManualPost({ brand, day: body['day'], caption: body['caption'], imageKey: body['imageKey'], channels: body['channels'] }, allowed, Date.now());
  if (!(await imageExists(post.imageKey))) throw new EditError('the picture was not found. Add it again.');

  await saveManual({ posts: [...file.posts, post] }, etag);
  return json(200, { post: post.id, date: post.date });
}

async function deletePost(id: string | null): Promise<Response> {
  if (!id || !isManualId(id)) throw new EditError('post is required');
  const { file, etag } = await loadManual();
  const post = file.posts.find((p) => p.id === id);
  if (!post) throw new EditError('no such post', 404);
  if (!isEditable(toScheduled(post), Date.now())) throw new EditError('this post is already due or sent, so it can no longer be deleted', 409);

  await saveManual({ posts: file.posts.filter((p) => p.id !== id) }, etag);
  // Tidy up after the post is gone; a failure here only leaves an unused file behind.
  const { overrides, etag: overridesEtag } = await loadOverrides();
  const edit = overrides[id];
  if (edit) {
    const { [id]: _removed, ...rest } = overrides;
    await saveOverrides(rest, overridesEtag).catch(() => undefined);
    if (edit.imageKey) await deleteImage(edit.imageKey).catch(() => undefined);
  }
  await deleteImage(post.imageKey).catch(() => undefined);
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
