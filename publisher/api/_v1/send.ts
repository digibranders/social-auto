/**
 * Sends a customer's post right now instead of waiting for the daily run. Called by a product's server with its own key.
 *
 * POST /api/v1/send   {"externalId", "postId"}
 *                     sends a post the product made, to its chosen channels. 200 with the post as it now stands, and "failed": true when a channel
 *                     refused it (the post then stays due for 20 hours, so the next daily run tries again); 409 when it has already gone out.
 */
import { findWorkspace, isExternalId } from '../../lib/clients.js';
import { apiError, channelProblem, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { dateNewPostNow } from '../../lib/manual-service.js';
import { isManualId, toScheduled } from '../../lib/manual.js';
import { postView, scheduledView } from '../../lib/post-view.js';
import { productOf } from '../../lib/product-request.js';
import { sendPost } from '../../lib/send-post.js';
import { loadChannels, loadClients, loadManual, loadPauses, loadPosted, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const { externalId, postId } = body;
  if (!isExternalId(externalId)) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  if (typeof postId !== 'string' || !isManualId(postId)) return apiError(400, 'INVALID_REQUEST', 'postId is required');

  try {
    const { file: clients } = await loadClients();
    const workspace = findWorkspace(clients, product.id, externalId);
    if (!workspace) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');

    // Already out on every channel: nothing to send, and sending again would post it twice.
    const [{ file: manual }, { file: channels }, { log }, { file: pauses }] = await Promise.all([loadManual(), loadChannels(), loadPosted(), loadPauses()]);
    const existing = manual.posts.find((p) => p.id === postId && p.brand === workspace.brand);
    if (!existing) return apiError(404, 'POST_NOT_FOUND', 'no such post');
    const before = scheduledView(toScheduled(existing), channels, log, Date.now(), undefined, pauses);
    if (before['state'] === 'published') return apiError(409, 'POST_ALREADY_SENT', 'this post has already gone out');
    if (before['state'] === 'skipped') return apiError(409, 'POST_SKIPPED', 'this post was skipped, so it is not being sent');
    if (before['state'] === 'paused') return apiError(409, 'PAUSED', 'this post is paused, so it is not being sent. Resume it first');

    const post = await dateNewPostNow(postId, Date.now(), workspace.brand);
    const origin = process.env['PUBLIC_ORIGIN'] ?? new URL(request.url).origin;
    const outcome = await sendPost(toScheduled(post), origin, false, pauses);
    const [{ file: nowChannels }, { log: nowLog }] = await Promise.all([loadChannels(), loadPosted()]);
    return json(200, { post: postView(post, nowChannels, nowLog, Date.now(), origin, pauses), failed: outcome.failed, problems: [outcome.instagram, ...outcome.facebook, ...outcome.linkedin, ...outcome.google, ...outcome.accounts].filter((r) => r['status'] === 'failed').map((r) => channelProblem(String(r['account'] ?? 'Instagram'), String(r['error'] ?? 'unknown error'))) });
  } catch (error) {
    return errorResponse(error, 'send the post');
  }
}
