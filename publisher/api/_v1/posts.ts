/**
 * A customer's scheduled posts. Called by a product's server with its own key; a product only reaches posts of
 * workspaces it created.
 *
 * POST   /api/v1/posts                              {"externalId", "day": "2026-11-20", "time"?: "14:30", "caption", "pictureId", "channels"?: ["linkedin:..."]}
 *                                                   goes out on that day at the time given (India time; 10:00 when left out), to the chosen channels (default: all connected)
 * GET    /api/v1/posts?externalId=...[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 *                                                   all of the customer's posts (planned and extra), earliest first, and where each stands on each channel;
 *                                                   from is the first day shown and to the last, both in India time
 * PATCH  /api/v1/posts?externalId=...&postId=...    {"day"?, "time"?, "caption"?, "pictureId"?, "channels"?}: changes a post a product made, while it has not gone out.
 *                                                   A scheduled post that was written and approved for the customer (planned) can only be moved: {"day"?, "time"?, "network"?}. With no network every network of
 *                                                   the post moves together; with a network (or an id like "<post>~linkedin") only that network's time changes, and the post is listed as two
 *                                                   posts from then on, "<post>" for the networks on its own time and "<post>~<network>" for the one with a time of its own (with that network's
 *                                                   words and picture). Moving a network to the post's own moment puts it back on the post. A network that already sent the post cannot be moved.
 *                                                   Its words and pictures stay.
 * DELETE /api/v1/posts?externalId=...&postId=...    removes a post that has not gone out yet
 */
import type { ScheduledPost } from '../../lib/schedule.js';
import { releasedSchedule } from '../../lib/customer-skip.js';
import { editPost } from '../../lib/editing.js';
import { findWorkspace, isExternalId } from '../../lib/clients.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { removeNewPost, saveNewPost, updateNewPost } from '../../lib/manual-service.js';
import { isManualId, toScheduled } from '../../lib/manual.js';
import { isPlatform } from '../../lib/variants.js';
import { applyOverrides, EditError, platformOfChannel, splitId } from '../../lib/overrides.js';
import { postView, scheduledView } from '../../lib/post-view.js';
import { productOf } from '../../lib/product-request.js';
import { deleteImage, loadChannels, loadClients, loadManual, loadOverrides, loadPauses, loadPosted, saveImage, saveOverrides, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 16 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The start of a day (YYYY-MM-DD) in India time, as a moment, or null when it is not a real day. */
function startOfDay(value: string | null): number | null {
  if (value === null || !DAY.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00+05:30`);
  return Number.isNaN(at) ? null : at;
}

const originOf = (request: Request): string => process.env['PUBLIC_ORIGIN'] ?? new URL(request.url).origin;

type Caller = { brand: string };

/** The workspace named by externalId, if the calling product owns it; otherwise the response to send. */
async function workspaceFor(request: Request, externalId: unknown): Promise<Caller | Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (!isExternalId(externalId)) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  const { file } = await loadClients();
  const workspace = findWorkspace(file, product.id, externalId);
  return workspace ? { brand: workspace.brand } : apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
}

const failure = errorResponse;

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const caller = await workspaceFor(request, body['externalId']);
  if (caller instanceof Response) return caller;
  try {
    const post = await saveNewPost({ brand: caller.brand, day: body['day'], time: body['time'], caption: body['caption'], imageKey: body['pictureId'], channels: body['channels'], variants: body['variants'], allowInstagram: false }, Date.now());
    const [{ file: channels }, { log }, { file: pauses }] = await Promise.all([loadChannels(), loadPosted(), loadPauses()]);
    return json(201, { post: postView(post, channels, log, Date.now(), originOf(request), pauses) });
  } catch (error) {
    return failure(error, 'schedule the post');
  }
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const caller = await workspaceFor(request, params.get('externalId'));
  if (caller instanceof Response) return caller;
  const from = params.has('from') ? startOfDay(params.get('from')) : null;
  const to = params.has('to') ? startOfDay(params.get('to')) : null;
  if ((params.has('from') && from === null) || (params.has('to') && to === null)) return apiError(400, 'INVALID_DAY', 'from and to must be days like 2026-11-20');
  try {
    const [{ file: manual }, { file: channels }, { log }, { overrides }, { file: pauses }] = await Promise.all([loadManual(), loadChannels(), loadPosted(), loadOverrides(), loadPauses()]);
    const now = Date.now();
    const origin = originOf(request);
    // Planned posts carry the customer's workspace id as their client; dashboard edits are applied on top.
    const planned = releasedSchedule.read().filter((p) => (p.brand ?? 'default') === caller.brand);
    const posts = applyOverrides([...planned, ...manual.posts.filter((p) => p.brand === caller.brand).map(toScheduled)], overrides)
      .filter((p) => (from === null || Date.parse(p.date) >= from) && (to === null || Date.parse(p.date) < to + DAY_MS))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    return json(200, { posts: posts.map((p) => scheduledView(p, channels, log, now, origin, pauses)) });
  } catch (error) {
    return failure(error, 'read the posts');
  }
}

/** The only things about a planned post that can change, as a product sees it. */
const PLANNED_FIELDS = new Set(['day', 'time', 'network']);

/**
 * Moves a scheduled post that was written and approved for the customer. Its words and pictures stay. With no network every network of the post moves together; with `network`
 * (or an id like `<post>~linkedin`) only that network moves, and the post is shown as two posts from then on, each at its own time. A network that has already been sent the post
 * cannot be moved.
 */
async function movePlanned(request: Request, brand: string, postId: string, body: Record<string, unknown>): Promise<Response> {
  const extra = Object.keys(body).filter((k) => !PLANNED_FIELDS.has(k) && body[k] !== undefined);
  if (extra.length > 0) return apiError(400, 'INVALID_REQUEST', 'a scheduled post written for you can only be moved: send its day and/or time, and optionally the network');
  if (body['day'] === undefined && body['time'] === undefined) return apiError(400, 'NOTHING_TO_CHANGE', 'say the day and/or time to move it to');
  const named = splitId(postId);
  const network = body['network'] ?? named.network ?? undefined;
  if (network !== undefined && !isPlatform(network)) return apiError(400, 'INVALID_REQUEST', 'network must be instagram, facebook, linkedin or google');
  // Only this customer's own posts are looked at, so another customer's post is simply "not found".
  const own = releasedSchedule.read().filter((p) => (p.brand ?? 'default') === brand);
  const post = own.find((p) => p.id === named.base);
  if (!post) throw new EditError('no such post', 404, 'POST_NOT_FOUND');
  const now = Date.now();
  const { overrides } = await loadOverrides();
  if (network !== undefined) {
    // A network that was already sent the post under the post's own id would be sent it again at its new time.
    const { log } = await loadPosted();
    const sent = (post.channels ?? []).some((channel) => platformOfChannel(channel) === network && Object.keys(log).some((key) => key.startsWith(`${post.id}|${network}`)));
    if (sent) throw new EditError('this post has already gone out on that network, so its time can no longer be changed', 409, 'POST_NOT_EDITABLE');
  }
  // Without a day the post stays on its day (as it is now, with any earlier move applied); only the time changes.
  const parts = applyOverrides([post], overrides);
  const shown = (network === undefined ? undefined : parts.find((p) => p.id === `${post.id}~${network}`)) ?? parts.find((p) => p.id === post.id) ?? parts[0] ?? post;
  const day = body['day'] ?? new Date(Date.parse(shown.date) + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const time = body['time'] === undefined ? {} : { time: body['time'] };
  const action = network === undefined ? ({ kind: 'move', day, ...time } as const) : ({ kind: 'moveNetwork', network, day, ...time } as const);
  await editPost({ load: loadOverrides, save: saveOverrides, saveImage, deleteImage }, own, post.id, action, now);
  const [{ file: channels }, { log }, { file: pauses }, { overrides: after }] = await Promise.all([loadChannels(), loadPosted(), loadPauses(), loadOverrides()]);
  const moved = applyOverrides([post], after);
  const answer = (network === undefined ? undefined : moved.find((p) => p.id === `${post.id}~${network}`)) ?? moved.find((p) => p.id === post.id) ?? moved[0];
  return json(200, { post: scheduledView(answer as ScheduledPost, channels, log, Date.now(), originOf(request), pauses), ...(moved.length > 1 ? { posts: moved.map((p) => scheduledView(p, channels, log, Date.now(), originOf(request), pauses)) } : {}) });
}

export async function PATCH(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const params = new URL(request.url).searchParams;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const caller = await workspaceFor(request, params.get('externalId'));
  if (caller instanceof Response) return caller;
  try {
    const id = params.get('postId');
    if (typeof id === 'string' && !isManualId(id)) return await movePlanned(request, caller.brand, id, body);
    const post = await updateNewPost(params.get('postId'), { day: body['day'], time: body['time'], caption: body['caption'], imageKey: body['pictureId'], channels: body['channels'], variants: body['variants'] }, Date.now(), caller.brand);
    const [{ file: channels }, { log }, { file: pauses }] = await Promise.all([loadChannels(), loadPosted(), loadPauses()]);
    return json(200, { post: postView(post, channels, log, Date.now(), originOf(request), pauses) });
  } catch (error) {
    return failure(error, 'change the post');
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const caller = await workspaceFor(request, params.get('externalId'));
  if (caller instanceof Response) return caller;
  try {
    await removeNewPost(params.get('postId'), Date.now(), caller.brand);
    return json(200, { ok: true });
  } catch (error) {
    return failure(error, 'delete the post');
  }
}
