/**
 * A customer's scheduled posts. Called by a product's server with its own key; a product only reaches posts of
 * workspaces it created.
 *
 * POST   /api/v1/posts                              {"externalId", "day": "2026-11-20", "caption", "pictureId", "channels"?: ["linkedin:..."]}
 *                                                   goes out at 10:00 IST on that day, to the chosen channels (default: all connected)
 * GET    /api/v1/posts?externalId=...[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 *                                                   all of the customer's posts (planned and extra), earliest first, and where each stands on each channel;
 *                                                   from is the first day shown and to the last, both in India time
 * DELETE /api/v1/posts?externalId=...&postId=...    removes a post that has not gone out yet
 */
import { schedule as scheduleData } from '../../data/schedule.js';
import { findWorkspace, isExternalId } from '../../lib/clients.js';
import { describeError, json } from '../../lib/http.js';
import { removeNewPost, saveNewPost } from '../../lib/manual-service.js';
import { toScheduled } from '../../lib/manual.js';
import { applyOverrides, EditError } from '../../lib/overrides.js';
import { postView, scheduledView } from '../../lib/post-view.js';
import { productOf } from '../../lib/product-request.js';
import { parseSchedule } from '../../lib/schedule.js';
import { loadChannels, loadClients, loadManual, loadOverrides, loadPosted, storeConfigured } from '../../lib/store.js';

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
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (!isExternalId(externalId)) return json(400, { error: 'externalId is required' });
  const { file } = await loadClients();
  const workspace = findWorkspace(file, product.id, externalId);
  return workspace ? { brand: workspace.brand } : json(404, { error: 'no such workspace' });
}

function failure(error: unknown, what: string): Response {
  if (error instanceof EditError) return json(error.status, { error: error.message });
  console.error(describeError(error));
  return json(500, { error: `could not ${what}` });
}

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return json(400, { error: 'send JSON' });
  const caller = await workspaceFor(request, body['externalId']);
  if (caller instanceof Response) return caller;
  try {
    const post = await saveNewPost({ brand: caller.brand, day: body['day'], caption: body['caption'], imageKey: body['pictureId'], channels: body['channels'], allowInstagram: false }, Date.now());
    const [{ file: channels }, { log }] = await Promise.all([loadChannels(), loadPosted()]);
    return json(201, { post: postView(post, channels, log, Date.now(), originOf(request)) });
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
  if ((params.has('from') && from === null) || (params.has('to') && to === null)) return json(400, { error: 'from and to must be days like 2026-11-20' });
  try {
    const [{ file: manual }, { file: channels }, { log }, { overrides }] = await Promise.all([loadManual(), loadChannels(), loadPosted(), loadOverrides()]);
    const now = Date.now();
    const origin = originOf(request);
    // Planned posts carry the customer's workspace id as their client; dashboard edits are applied on top.
    const planned = parseSchedule(scheduleData).filter((p) => (p.brand ?? 'default') === caller.brand);
    const posts = applyOverrides([...planned, ...manual.posts.filter((p) => p.brand === caller.brand).map(toScheduled)], overrides)
      .filter((p) => (from === null || Date.parse(p.date) >= from) && (to === null || Date.parse(p.date) < to + DAY_MS))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    return json(200, { posts: posts.map((p) => scheduledView(p, channels, log, now, origin)) });
  } catch (error) {
    return failure(error, 'read the posts');
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
