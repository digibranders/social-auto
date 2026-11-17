/**
 * The end of a customer's paid period. Called by a product's server with its own key; a product only reaches workspaces it created.
 *
 * POST /api/v1/workspaces/billing   {"externalId", "endDate": "2026-12-10" | null}   answers {"workspace"} (with `billing: {endDate, lastPostingDay, state}`)
 *
 * `endDate` is the billing date: posts go out until the day BEFORE it (billing on 10 Dec: the last posts go out on 9 Dec), India time, and from then on every post of
 * the workspace is held, on every channel (planned, hand-made, carousel, reel), whatever was drawn or approved. Held posts are not deleted. `null` clears it (the customer
 * kept her plan); a later date is a renewal. Posts whose day passed while they were held are skipped, never sent late; posts still ahead go out again. A date that has
 * already passed stops posting at once. Sending and every call that spends money answer 409 PLAN_ENDED after the date. Doing the same thing twice is safe.
 * `X-Social-Actor` is recorded when sent.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { findWorkspace, isExternalId } from '../../lib/clients.js';
import { json } from '../../lib/http.js';
import { isRealDay, setBilling } from '../../lib/pauses.js';
import { productOf } from '../../lib/product-request.js';
import { engineFor } from '../../lib/product-workspace.js';
import { loadClients, loadPauses, savePauses, storeConfigured } from '../../lib/store.js';
import { workspaceResponse } from './workspaces.js';

const MAX_BODY_BYTES = 1024;

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  if (!isExternalId(body['externalId'])) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  const endDate = body['endDate'];
  if (endDate !== null && !isRealDay(endDate)) return apiError(400, 'INVALID_END_DATE', 'endDate must be a real day as YYYY-MM-DD, or null to clear it');
  try {
    const { file: clients } = await loadClients();
    const client = findWorkspace(clients, product.id, body['externalId']);
    if (!client) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    const { file: pauses, etag } = await loadPauses();
    const before = pauses.billing?.[client.brand]?.endDate ?? null;
    // The same date again changes nothing, so the time it was first set stays.
    if (before !== endDate) {
      const actor = request.headers.has('x-social-actor') ? actorOf(request) : product.id;
      await savePauses(setBilling(pauses, client.brand, endDate, actor, new Date().toISOString()), etag);
    }
    // The poster service is told every time (not only when the date changed), so a call that failed before is mended by repeating it. Never in the way of the answer.
    const engine = engineFor(product.id, client.brand);
    if (!(engine instanceof Response)) await engine.setBillingEnd(endDate, request.headers.has('x-social-actor') ? engineActor(product.id, actorOf(request)) : engineActor(product.id, null));
    return json(200, { workspace: await workspaceResponse(clients, client) });
  } catch (error) {
    return errorResponse(error, 'change the billing date');
  }
}
