/**
 * The pictures the customer may still draw this week, for each channel.
 *
 * GET /api/v1/limits?externalId=...   {"week": {"from", "to", "restart"}, "limit": 5, "channels": [{"network", "limit", "used", "left"}]}
 *
 * The week runs Monday to Sunday in India time and starts again on `restart`. Every picture drawn counts, a redraw and the picture of a network added later too;
 * a try that bought nothing does not. A request that needs more pictures than a channel has left is refused with 429 PICTURE_LIMIT_REACHED.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { engineFor, workspaceFor } from '../../lib/product-workspace.js';

export async function GET(request: Request): Promise<Response> {
  const found = await workspaceFor(request, new URL(request.url).searchParams.get('externalId'));
  if (found instanceof Response) return found;
  try {
    const engine = engineFor(found.product.id, found.workspace.brand);
    if (engine instanceof Response) return engine;
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    const view = await engine.limits(by);
    return json(200, { week: view.week, limit: view.limit, channels: view.channels });
  } catch (error) {
    return errorResponse(error, 'read the picture limits');
  }
}
