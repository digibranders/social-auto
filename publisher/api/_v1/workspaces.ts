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
import { describeError, json } from '../../lib/http.js';
import { EditError } from '../../lib/overrides.js';
import { productOf } from '../../lib/product-request.js';
import { loadChannels, loadClients, saveClients, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 2 * 1024;

function channelView(channel: Channel): Record<string, unknown> {
  return {
    id: channel.id,
    platform: channel.platform,
    account: channelLabel(channel),
    connectedAt: channel.connectedAt,
    ...(channel.platform === 'linkedin' || channel.platform === 'instagram' ? { expiresAt: channel.expiresAt } : {}),
  };
}

function workspaceView(client: AddedClient, channels: Channel[]): Record<string, unknown> {
  return { id: client.brand, externalId: client.externalId, name: client.name ?? null, channels: channels.map(channelView) };
}

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return json(400, { error: 'send JSON' });

  try {
    const { file, etag } = await loadClients();
    const result = ensureWorkspace(file, product.id, body['externalId'], body['name'], Date.now());
    if (result.created) await saveClients(result.file, etag);
    const { file: channels } = await loadChannels();
    return json(result.created ? 201 : 200, { workspace: workspaceView(result.client, channelsFor(channels, result.client.brand)) });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save the workspace' });
  }
}

export async function GET(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  const externalId = new URL(request.url).searchParams.get('externalId');
  if (!isExternalId(externalId)) return json(400, { error: 'externalId is required' });

  try {
    const [{ file }, { file: channels }] = await Promise.all([loadClients(), loadChannels()]);
    const client = findWorkspace(file, product.id, externalId);
    if (!client) return json(404, { error: 'no such workspace' });
    return json(200, { workspace: workspaceView(client, channelsFor(channels, client.brand)) });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'could not read the workspace' });
  }
}
