/**
 * Dashboard edits to a post that has not gone out yet. Called only by the dashboard's server, with its own
 * secret (EDIT_SECRET), never by browsers directly.
 *
 * POST /api/edit?post=<id>&action=caption   body: {"caption": "..."}
 * POST /api/edit?post=<id>&action=image     body: the JPG file
 * POST /api/edit?post=<id>&action=variants body: {"variants": {"linkedin": {"caption": "...", "pictureId": "..."}, ...}}  own caption and/or picture per platform; a platform left out stays as it is, null puts it back on the main ones
 * POST /api/edit?post=<id>&action=revert
 * POST /api/edit?post=<id>&action=move       body: {"day": "2026-11-12", "time"?: "14:30"}  a post takes a new day and time; one planned post per client per day, and a time left out stays as planned
 * POST /api/edit?post=<id>&action=skip      the post stays on the calendar but is never sent (while its time is still ahead)
 * POST /api/edit?post=<id>&action=unskip    brings it back
 */
import { scheduleData } from '../lib/schedule-source.js';
import { isManualId, toScheduled } from '../lib/manual.js';
import { updateNewPost } from '../lib/manual-service.js';
import { editPost, type EditAction } from '../lib/editing.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { EditError, MAX_IMAGE_BYTES } from '../lib/overrides.js';
import { parseSchedule } from '../lib/schedule.js';
import { deleteImage, loadManual, loadOverrides, saveImage, saveOverrides, storeConfigured } from '../lib/store.js';

const store = { load: loadOverrides, save: saveOverrides, saveImage, deleteImage };

/** The day and time asked for by a move. */
async function readMove(request: Request): Promise<{ day: unknown; time: unknown }> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null) throw new EditError('send {"day": "2026-11-12"} as JSON');
  const { day, time } = body as Record<string, unknown>;
  return { day, time };
}

async function readAction(request: Request, action: string | null): Promise<EditAction> {
  if (action === 'move') {
    const { day, time } = await readMove(request);
    return { kind: 'move', day, ...(time === undefined ? {} : { time }) };
  }
  if (action === 'revert' || action === 'skip' || action === 'unskip') return { kind: action };
  if (action === 'caption') {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null) throw new EditError('send {"caption": "..."} as JSON');
    return { kind: 'caption', caption: (body as Record<string, unknown>)['caption'] };
  }
  if (action === 'variants') {
    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== 'object' || body === null) throw new EditError('send {"variants": {...}} as JSON');
    return { kind: 'variants', variants: (body as Record<string, unknown>)['variants'] };
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
    if (url.searchParams.get('action') === 'move' && isManualId(id)) {
      // A hand-made post lives in its own file, and may take a time as well as a day.
      const { day, time } = await readMove(request);
      await updateNewPost(id, { day, ...(time === undefined ? {} : { time }) }, Date.now());
      return json(200, { post: id, edited: false });
    }
    const action = await readAction(request, url.searchParams.get('action'));
    const { file: manual } = await loadManual();
    const result = await editPost(store, [...parseSchedule(scheduleData), ...manual.posts.map(toScheduled)], id, action, Date.now());
    return json(200, { ...result });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save the change' });
  }
}
