/**
 * A customer's scheduled posts. Called by a product's server with its own key; a product only reaches posts of
 * workspaces it created.
 *
 * POST   /api/v1/posts                              {"externalId", "day": "2026-11-20", "caption", "pictureId", "channels"?: ["linkedin:..."]}
 *                                                   goes out at 10:00 IST on that day, to the chosen channels (default: all connected)
 * GET    /api/v1/posts?externalId=...               the customer's extra posts and where each stands on each channel
 * DELETE /api/v1/posts?externalId=...&postId=...    removes a post that has not gone out yet
 */
import { findWorkspace, isExternalId } from '../../lib/clients.js';
import { describeError, json } from '../../lib/http.js';
import { removeNewPost, saveNewPost } from '../../lib/manual-service.js';
import { EditError } from '../../lib/overrides.js';
import { postView } from '../../lib/post-view.js';
import { productOf } from '../../lib/product-request.js';
import { loadChannels, loadClients, loadManual, loadPosted, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 16 * 1024;

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
    return json(201, { post: postView(post, channels, log, Date.now()) });
  } catch (error) {
    return failure(error, 'schedule the post');
  }
}

export async function GET(request: Request): Promise<Response> {
  const caller = await workspaceFor(request, new URL(request.url).searchParams.get('externalId'));
  if (caller instanceof Response) return caller;
  try {
    const [{ file: manual }, { file: channels }, { log }] = await Promise.all([loadManual(), loadChannels(), loadPosted()]);
    const now = Date.now();
    const posts = manual.posts.filter((p) => p.brand === caller.brand).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    return json(200, { posts: posts.map((p) => postView(p, channels, log, now)) });
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
