/**
 * The days of the week a customer's posts go out on, for each channel. Called by a product's server with its own key; a product only reaches workspaces it created.
 *
 * GET /api/v1/schedule?externalId=...                         {"schedule": {"channels": {"instagram": {"days": ["mon", "tue", "sat"], "nextWeek": ["2026-11-16", ...]}}}}
 *                                                             only the channels that have days of their own; nextWeek is what a batch starting on the next Monday would give
 * PUT /api/v1/schedule  {"externalId", "channels": {"instagram": ["mon", "tue", "sat"], "facebook": ["wed", "fri"]}}
 *                                                             replaces the whole setting (a channel that is not listed goes back to the usual spread; {} clears it); answers like GET
 *
 * The days are used when a batch is written (POST /api/v1/site-jobs): a week already written or drawn never moves.
 */
import { apiError, errorResponse } from '../../lib/api-error.js';
import { findWorkspace, isExternalId, type AddedClient } from '../../lib/clients.js';
import { json } from '../../lib/http.js';
import { nextMonday } from '../../lib/plan-days.js';
import { parsePostingDays, postingDaysOf, setPostingDays, weekDatesFrom } from '../../lib/posting-days.js';
import { productOf } from '../../lib/product-request.js';
import { loadClients, saveClients, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 2 * 1024;

function view(client: AddedClient): Record<string, unknown> {
  const monday = nextMonday(Date.now());
  const channels = Object.fromEntries(Object.entries(postingDaysOf(client)).map(([network, days]) => [network, { days, nextWeek: weekDatesFrom(days ?? [], monday) }]));
  return { schedule: { channels } };
}

export async function GET(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  const externalId = new URL(request.url).searchParams.get('externalId');
  if (!isExternalId(externalId)) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  try {
    const { file } = await loadClients();
    const client = findWorkspace(file, product.id, externalId);
    if (!client) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    return json(200, view(client));
  } catch (error) {
    return errorResponse(error, 'read the schedule');
  }
}

export async function PUT(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  if (!isExternalId(body['externalId'])) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  try {
    const days = parsePostingDays(body['channels']);
    const { file, etag } = await loadClients();
    const client = findWorkspace(file, product.id, body['externalId']);
    if (!client) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    const updated = setPostingDays(file, client.brand, days);
    await saveClients(updated, etag);
    return json(200, view(findWorkspace(updated, product.id, body['externalId']) as AddedClient));
  } catch (error) {
    return errorResponse(error, 'save the schedule');
  }
}
