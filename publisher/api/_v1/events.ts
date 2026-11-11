/**
 * What a product has been told (or should have been told) about its customers, so it can catch up after being down or missing a message.
 *
 * GET /api/v1/events?after=<seq>&limit=<1..100>   {"events": [{"seq", "id", "type", "createdAt", "data"}], "hasMore"}, oldest first, only this product's
 *
 * Remember the last `seq` you handled and pass it as `after` (leave it out to read from the start). Events are kept for 14 days. The same events are sent
 * to the webhook address; an event can arrive both ways or more than once, so handle each `id` once.
 */
import { apiError, errorResponse } from '../../lib/api-error.js';
import { eventsAfter } from '../../lib/outbox.js';
import { json } from '../../lib/http.js';
import { productOf } from '../../lib/product-request.js';
import { loadOutbox, storeConfigured } from '../../lib/store.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function GET(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  const params = new URL(request.url).searchParams;
  const after = params.get('after') === null ? 0 : Number(params.get('after'));
  const limit = params.get('limit') === null ? DEFAULT_LIMIT : Number(params.get('limit'));
  if (!Number.isInteger(after) || after < 0) return apiError(400, 'INVALID_REQUEST', 'after must be a whole number from 0');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return apiError(400, 'INVALID_REQUEST', `limit must be a whole number from 1 to ${MAX_LIMIT}`);
  try {
    const { outbox } = await loadOutbox();
    return json(200, { ...eventsAfter(outbox, product.id, after, limit) });
  } catch (error) {
    return errorResponse(error, 'read the events');
  }
}
