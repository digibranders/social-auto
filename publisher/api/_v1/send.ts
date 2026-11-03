/**
 * Sends a customer's post right now instead of waiting for the daily run. Called by a product's server with its own key.
 *
 * POST /api/v1/send   {"externalId", "postId"}
 *                     sends a post the product made, to its chosen channels. 200 with the post as it now stands, and "failed": true when a channel
 *                     refused it (the post then stays due for 20 hours, so the next daily run tries again); 409 when it has already gone out.
 */
import { findWorkspace, isExternalId } from '../../lib/clients.js';
import { describeError, json } from '../../lib/http.js';
import { dateNewPostNow } from '../../lib/manual-service.js';
import { isManualId, toScheduled } from '../../lib/manual.js';
import { EditError } from '../../lib/overrides.js';
import { postView, scheduledView } from '../../lib/post-view.js';
import { productOf } from '../../lib/product-request.js';
import { sendPost } from '../../lib/send-post.js';
import { loadChannels, loadClients, loadManual, loadPosted, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return json(400, { error: 'send JSON' });
  const { externalId, postId } = body;
  if (!isExternalId(externalId)) return json(400, { error: 'externalId is required' });
  if (typeof postId !== 'string' || !isManualId(postId)) return json(400, { error: 'postId is required' });

  try {
    const { file: clients } = await loadClients();
    const workspace = findWorkspace(clients, product.id, externalId);
    if (!workspace) return json(404, { error: 'no such workspace' });

    // Already out on every channel: nothing to send, and sending again would post it twice.
    const [{ file: manual }, { file: channels }, { log }] = await Promise.all([loadManual(), loadChannels(), loadPosted()]);
    const existing = manual.posts.find((p) => p.id === postId && p.brand === workspace.brand);
    if (!existing) return json(404, { error: 'no such post' });
    const before = scheduledView(toScheduled(existing), channels, log, Date.now());
    if (before['state'] === 'published') return json(409, { error: 'this post has already gone out' });

    const post = await dateNewPostNow(postId, Date.now(), workspace.brand);
    const origin = process.env['PUBLIC_ORIGIN'] ?? new URL(request.url).origin;
    const outcome = await sendPost(toScheduled(post), origin, false);
    const [{ file: nowChannels }, { log: nowLog }] = await Promise.all([loadChannels(), loadPosted()]);
    return json(200, { post: postView(post, nowChannels, nowLog, Date.now(), origin), failed: outcome.failed, problems: [outcome.instagram, ...outcome.facebook, ...outcome.linkedin, ...outcome.google, ...outcome.accounts].filter((r) => r['status'] === 'failed').map((r) => ({ account: String(r['account'] ?? 'Instagram'), error: String(r['error'] ?? 'unknown error') })) });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not send the post' });
  }
}
