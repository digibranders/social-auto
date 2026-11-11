/**
 * The customer's topics and which of her connected networks each one lacks (so "add Facebook to this topic" can be offered).
 *
 * GET /api/v1/topics?externalId=...   {"topics": [{"batchId", "postId", "headline", "networks": [{"network", "status"}], "missing": ["facebook"]}], "connected": ["instagram", ...]}
 *
 * `status` of a network is "written" (words only, not drawn yet) or the status of its newest picture. `missing` lists her connected networks the topic does not
 * have; a topic that was put away unanswered (expired) offers none.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { channelsFor } from '../../lib/channels.js';
import { errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { engineFor, workspaceFor } from '../../lib/product-workspace.js';
import { loadChannels } from '../../lib/store.js';
import { topicsOf } from '../../lib/topics.js';

export async function GET(request: Request): Promise<Response> {
  const found = await workspaceFor(request, new URL(request.url).searchParams.get('externalId'));
  if (found instanceof Response) return found;
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    const [posters, batches, { file }] = await Promise.all([engine.listPosters('all', by), engine.listBatches(by), loadChannels()]);
    const connected = [...new Set(channelsFor(file, found.workspace.brand).map((c) => c.platform))];
    return json(200, { topics: topicsOf(posters, batches.batches, connected), connected });
  } catch (error) {
    return errorResponse(error, 'read the topics');
  }
}
