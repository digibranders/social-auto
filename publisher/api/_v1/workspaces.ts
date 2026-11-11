/**
 * A product's customers ("workspaces"). Called by a product's server with its own key; a product only ever
 * sees the workspaces it created.
 *
 * POST /api/v1/workspaces                 {"externalId": "<your id for the customer>", "name": "Shop name"}
 *                                         creates the workspace, or returns the existing one (safe to repeat)
 * GET  /api/v1/workspaces?externalId=...  the workspace and its connected channels (never their tokens)
 */
import { channelLabel, channelsFor, type Channel } from '../../lib/channels.js';
import { ensureWorkspace, findWorkspace, isExternalId, type AddedClient } from '../../lib/clients.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { productOf } from '../../lib/product-request.js';
import { brandIsPaused, isPaused, type PauseFile } from '../../lib/pauses.js';
import { loadChannels, loadClients, loadPauses, saveClients, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 2 * 1024;

function channelView(channel: Channel, pauses: PauseFile): Record<string, unknown> {
  return {
    id: channel.id,
    platform: channel.platform,
    account: channelLabel(channel),
    connectedAt: channel.connectedAt,
    // Held back by a pause on this account, on the whole workspace or on everything: posts are not sent to it until it is resumed.
    paused: isPaused(pauses, channel.brand, channel.id),
    ...(channel.platform === 'linkedin' || channel.platform === 'instagram' ? { expiresAt: channel.expiresAt } : {}),
  };
}

function workspaceView(client: AddedClient, channels: Channel[], pauses: PauseFile): Record<string, unknown> {
  return { id: client.brand, externalId: client.externalId, name: client.name ?? null, paused: brandIsPaused(pauses, client.brand), channels: channels.map((channel) => channelView(channel, pauses)) };
}

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');

  try {
    const { file, etag } = await loadClients();
    const result = ensureWorkspace(file, product.id, body['externalId'], body['name'], Date.now());
    if (result.created) await saveClients(result.file, etag);
    const [{ file: channels }, { file: pauses }] = await Promise.all([loadChannels(), loadPauses()]);
    return json(result.created ? 201 : 200, { workspace: workspaceView(result.client, channelsFor(channels, result.client.brand), pauses) });
  } catch (error) {
    return errorResponse(error, 'save the workspace');
  }
}

export async function GET(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  const externalId = new URL(request.url).searchParams.get('externalId');
  if (!isExternalId(externalId)) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');

  try {
    const [{ file }, { file: channels }, { file: pauses }] = await Promise.all([loadClients(), loadChannels(), loadPauses()]);
    const client = findWorkspace(file, product.id, externalId);
    if (!client) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    return json(200, { workspace: workspaceView(client, channelsFor(channels, client.brand), pauses) });
  } catch (error) {
    return errorResponse(error, 'read the workspace');
  }
}
