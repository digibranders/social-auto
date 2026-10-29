/**
 * Dashboard edits to a post that has not gone out yet. Called only by the dashboard's server, with its own
 * secret (EDIT_SECRET), never by browsers directly.
 *
 * POST /api/edit?post=<id>&action=caption   body: {"caption": "..."}
 * POST /api/edit?post=<id>&action=image     body: the JPG file
 * POST /api/edit?post=<id>&action=revert
 */
import { schedule as scheduleData } from '../data/schedule.js';
import { editPost, type EditAction } from '../lib/editing.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { EditError, MAX_IMAGE_BYTES } from '../lib/overrides.js';
import { parseSchedule } from '../lib/schedule.js';
import { deleteImage, loadOverrides, saveImage, saveOverrides, storeConfigured } from '../lib/store.js';

const store = { load: loadOverrides, save: saveOverrides, saveImage, deleteImage };

async function readAction(request: Request, action: string | null): Promise<EditAction> {
  if (action === 'revert') return { kind: 'revert' };
  if (action === 'caption') {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null) throw new EditError('send {"caption": "..."} as JSON');
    return { kind: 'caption', caption: (body as Record<string, unknown>)['caption'] };
  }
  if (action === 'image') {
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new EditError('picture is too large', 413);
    return { kind: 'image', bytes: new Uint8Array(await request.arrayBuffer()) };
  }
  throw new EditError('unknown action');
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'editing storage is not set up' });

  const url = new URL(request.url);
  const id = url.searchParams.get('post');
  if (!id) return json(400, { error: 'post is required' });

  try {
    const action = await readAction(request, url.searchParams.get('action'));
    const result = await editPost(store, parseSchedule(scheduleData), id, action, Date.now());
    return json(200, { ...result });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save the change' });
  }
}
