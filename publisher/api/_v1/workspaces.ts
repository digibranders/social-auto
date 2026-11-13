/**
 * A product's customers ("workspaces"). Called by a product's server with its own key; a product only ever
 * sees the workspaces it created.
 *
 * POST /api/v1/workspaces                 {"externalId": "<your id for the brand>", "name": "Shop name", "group"?: "<your id for the customer who owns several brands>"}
 *                                         creates the workspace, or returns the existing one (safe to repeat). Without a group the workspace is its own customer.
 * PATCH /api/v1/workspaces               {"externalId", "name"}  changes the name that is shown (screens and staff dashboard only: posters and captions are not touched); answers {"workspace"}
 * GET  /api/v1/workspaces?group=...       the customer's workspaces: {"workspaces": [{id, externalId, name, website, archived}], "brandsAllowed", "brandsUsed", "ceiling"}
 * GET  /api/v1/workspaces?externalId=...  the workspace and its connected channels (never their tokens)
 */
import { channelLabel, channelsFor, type Channel } from '../../lib/channels.js';
import { assertRoomForBrand, brandsAllowed, brandsUsed, BRANDS_CEILING, type BrandSettings } from '../../lib/brands.js';
import { ensureWorkspace, findWorkspace, groupOf, isExternalId, setWorkspaceName, workspacesInGroup, type AddedClient, type ClientsFile } from '../../lib/clients.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { disconnectedNotices, noticesFor } from '../../lib/workspace-notices.js';
import { releasedSchedule } from '../../lib/customer-skip.js';
import { toScheduled } from '../../lib/manual.js';
import { applyOverrides } from '../../lib/overrides.js';
import type { ScheduledPost } from '../../lib/schedule.js';
import { productOf } from '../../lib/product-request.js';
import { brandIsPaused, isPaused, type PauseFile } from '../../lib/pauses.js';
import { loadBrandSettings, loadChannels, loadClients, loadManual, loadOverrides, loadPauses, saveClients, storeConfigured } from '../../lib/store.js';

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

/** What a workspace says about the customer it belongs to: the group, how many brands are allowed and how many are in use. */
function groupFacts(file: ClientsFile, settings: BrandSettings, client: AddedClient): { id: string; brandsAllowed: number; brandsUsed: number } {
  const id = groupOf(client) ?? client.brand;
  const product = client.product ?? '';
  return { id, brandsAllowed: brandsAllowed(settings, product, id), brandsUsed: brandsUsed(workspacesInGroup(file, product, id)) };
}

function workspaceView(client: AddedClient, channels: Channel[], pauses: PauseFile, posts: readonly ScheduledPost[] = [], group?: { id: string; brandsAllowed: number; brandsUsed: number }): Record<string, unknown> {
  const paused = brandIsPaused(pauses, client.brand);
  return {
    id: client.brand,
    externalId: client.externalId,
    name: client.name ?? null,
    // The customer's website, once they have given one (it cannot be changed afterwards).
    website: client.website ?? null,
    ...(group ? { group } : {}),
    archived: client.archived === true,
    paused,
    // Read only: a customer approves their own posters, so this is always "manual" and nothing in the API changes it.
    approvalMode: 'manual',
    // Things the customer should know (a connection ending, posting paused), in plain words.
    notices: [...noticesFor(channels, paused, Date.now()), ...disconnectedNotices(posts, channels, Date.now())],
    channels: channels.map((channel) => channelView(channel, pauses)),
  };
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
    const result = ensureWorkspace(file, product.id, body['externalId'], body['name'], Date.now(), body['group']);
    const { settings } = await loadBrandSettings();
    if (result.created) {
      // The customer may have only so many brands. The count is taken from the file this write replaces (same etag), so two quick creates cannot both pass.
      const group = groupOf(result.client) as string;
      assertRoomForBrand(workspacesInGroup(file, product.id, group), brandsAllowed(settings, product.id, group), true);
      await saveClients(result.file, etag);
    }
    const [{ file: channels }, { file: pauses }] = await Promise.all([loadChannels(), loadPauses()]);
    return json(result.created ? 201 : 200, { workspace: workspaceView(result.client, channelsFor(channels, result.client.brand), pauses, [], groupFacts(result.file, settings, result.client)) });
  } catch (error) {
    return errorResponse(error, 'save the workspace');
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  if (!isExternalId(body['externalId'])) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');

  try {
    const { file, etag } = await loadClients();
    const client = findWorkspace(file, product.id, body['externalId']);
    if (!client) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    const renamed = setWorkspaceName(file, client.brand, body['name']);
    if (renamed !== file) await saveClients(renamed, etag);
    const updated = findWorkspace(renamed, product.id, body['externalId']) as AddedClient;
    const [{ file: channels }, { file: pauses }, { file: manual }, { overrides }, { settings }] = await Promise.all([loadChannels(), loadPauses(), loadManual(), loadOverrides(), loadBrandSettings()]);
    const posts = applyOverrides([...releasedSchedule.read().filter((p) => (p.brand ?? 'default') === updated.brand), ...manual.posts.filter((p) => p.brand === updated.brand).map(toScheduled)], overrides);
    return json(200, { workspace: workspaceView(updated, channelsFor(channels, updated.brand), pauses, posts, groupFacts(renamed, settings, updated)) });
  } catch (error) {
    return errorResponse(error, 'rename the workspace');
  }
}

/** One customer's workspaces (only this product's, only those stored under this group) with how many brands are allowed and in use. */
async function groupRead(productId: string, group: string | null): Promise<Response> {
  if (!isExternalId(group)) return apiError(400, 'INVALID_GROUP', 'group must be 1-64 letters, digits or . _ : -');
  try {
    const [{ file }, { settings }] = await Promise.all([loadClients(), loadBrandSettings()]);
    const members = workspacesInGroup(file, productId, group);
    return json(200, {
      workspaces: members.map((w) => ({ id: w.brand, externalId: w.externalId ?? null, name: w.name ?? null, website: w.website ?? null, archived: w.archived === true })),
      brandsAllowed: brandsAllowed(settings, productId, group),
      brandsUsed: brandsUsed(members),
      ceiling: BRANDS_CEILING,
    });
  } catch (error) {
    return errorResponse(error, 'read the workspaces');
  }
}

export async function GET(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  const params = new URL(request.url).searchParams;
  const externalId = params.get('externalId');
  if (externalId === null && params.has('group')) return groupRead(product.id, params.get('group'));
  if (!isExternalId(externalId)) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');

  try {
    const [{ file }, { file: channels }, { file: pauses }, { file: manual }, { overrides }, { settings }] = await Promise.all([loadClients(), loadChannels(), loadPauses(), loadManual(), loadOverrides(), loadBrandSettings()]);
    const client = findWorkspace(file, product.id, externalId);
    if (!client) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    // Her scheduled posts, with the team's and her own changes on them, so the notices can say which are on hold.
    const posts = applyOverrides([...releasedSchedule.read().filter((p) => (p.brand ?? 'default') === client.brand), ...manual.posts.filter((p) => p.brand === client.brand).map(toScheduled)], overrides);
    return json(200, { workspace: workspaceView(client, channelsFor(channels, client.brand), pauses, posts, groupFacts(file, settings, client)) });
  } catch (error) {
    return errorResponse(error, 'read the workspace');
  }
}
