/**
 * A customer's connected channels: what disconnecting one would stop, and disconnecting it. Called by a product's server with its own key; a product only reaches workspaces it created.
 *
 * GET  /api/v1/channels?externalId=...&channelId=...      {"scheduled": 6, "days": ["2026-11-18", ...], "approved": 4, "running": ["draw"], "onlyChannel": false}   what disconnecting it would stop
 * POST /api/v1/channels {"externalId", "action": "disconnect", "channelId", "confirmOnly"?: true}   (X-Social-Actor required)   answers {"workspace"}
 *
 * Disconnecting deletes our saved login for the channel and asks the network to forget it where it allows (best effort: Google, and LinkedIn when our app's credentials are set; Instagram and Facebook
 * are removed by the person in her own settings). Posts are not deleted: a post aimed at the channel is held and goes out again if the same account is connected again while its time window is open.
 * Numbers already collected stay. Refused (409 CONFLICT) while pictures or posts are being made for the channel; her only channel needs `confirmOnly: true` (else 409 ONLY_CHANNEL). A channel that is
 * already gone is a 200 that changes nothing.
 */
import { actorOf, engineActor } from '../../lib/actor.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { removeChannel, channelsFor, type Channel } from '../../lib/channels.js';
import { disconnectPreview, type DisconnectPreview, revokeAtNetwork, revokeEnvFromProcess, runningSentence } from '../../lib/channel-disconnect.js';
import { parseKey } from '../../lib/crypto.js';
import type { JobView } from '../../lib/engine-client.js';
import { findWorkspace, isExternalId } from '../../lib/clients.js';
import { forgetConnected, syncConnected } from '../../lib/connected-sync.js';
import { json } from '../../lib/http.js';
import { toScheduled } from '../../lib/manual.js';
import { applyOverrides } from '../../lib/overrides.js';
import { releasedSchedule } from '../../lib/customer-skip.js';
import { engineFor, workspaceFor } from '../../lib/product-workspace.js';
import { loadChannels, loadClients, loadManual, loadOverrides, loadPosted, saveChannels } from '../../lib/store.js';
import { workspaceResponse } from './workspaces.js';

const MAX_BODY_BYTES = 2 * 1024;
const CHANNEL_ID = /^(facebook:\d{5,25}|instagram:\d{5,25}|linkedin:[A-Za-z0-9_-]{4,64}|google:\d{1,25})$/;

/** What the engine says is in progress and approved for this workspace; an engine that is not set up or not answering says nothing. */
async function engineFacts(productId: string, brand: string, actor: string): Promise<{ jobs: JobView[]; approved: Array<{ network: string; date: string }> }> {
  const engine = engineOf(productId, brand);
  if (!engine) return { jobs: [], approved: [] };
  try {
    const [jobs, posters] = await Promise.all([engine.listJobs(actor), engine.listPosters('approved', actor)]);
    return { jobs, approved: posters.flatMap((p) => (p.date ? [{ network: p.network, date: p.date }] : [])) };
  } catch {
    return { jobs: [], approved: [] };
  }
}

function engineOf(productId: string, brand: string): Exclude<ReturnType<typeof engineFor>, Response> | null {
  const engine = engineFor(productId, brand);
  return engine instanceof Response ? null : engine;
}

async function previewFor(productId: string, brand: string, channelId: string, actor: string): Promise<{ channel: Channel; preview: DisconnectPreview } | null> {
  const { file } = await loadChannels();
  const mine = channelsFor(file, brand);
  const channel = mine.find((c) => c.id === channelId);
  if (!channel) return null;
  const [{ file: manual }, { overrides }, { log }, facts] = await Promise.all([loadManual(), loadOverrides(), loadPosted(), engineFacts(productId, brand, actor)]);
  const posts = applyOverrides([...releasedSchedule.read().filter((p) => (p.brand ?? 'default') === brand), ...manual.posts.filter((p) => p.brand === brand).map(toScheduled)], overrides);
  const approvedDays = facts.approved.filter((p) => p.network === channel.platform).map((p) => p.date);
  return { channel, preview: disconnectPreview({ channel, channels: mine, posts, posted: log, approvedDays, jobs: facts.jobs, now: Date.now() }) };
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const found = await workspaceFor(request, params.get('externalId'));
  if (found instanceof Response) return found;
  const channelId = params.get('channelId') ?? '';
  if (!CHANNEL_ID.test(channelId)) return apiError(400, 'INVALID_REQUEST', 'channelId must be the id of one of her channels, like instagram:1784140000001');
  try {
    const by = engineActor(found.product.id, request.headers.has('x-social-actor') ? actorOf(request) : null);
    const result = await previewFor(found.product.id, found.workspace.brand, channelId, by);
    if (!result) return apiError(404, 'NOT_FOUND', 'no such channel for this customer');
    return json(200, { ...result.preview });
  } catch (error) {
    return errorResponse(error, 'read the channel');
  }
}

export async function POST(request: Request): Promise<Response> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  if (!isExternalId(body['externalId'])) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  if (body['action'] !== 'disconnect') return apiError(400, 'INVALID_REQUEST', 'action must be "disconnect"');
  const channelId = body['channelId'];
  if (typeof channelId !== 'string' || !CHANNEL_ID.test(channelId)) return apiError(400, 'INVALID_REQUEST', 'channelId must be the id of one of her channels, like instagram:1784140000001');
  if (body['confirmOnly'] !== undefined && typeof body['confirmOnly'] !== 'boolean') return apiError(400, 'INVALID_REQUEST', 'confirmOnly must be true or false');
  const found = await workspaceFor(request, body['externalId']);
  if (found instanceof Response) return found;
  try {
    const by = engineActor(found.product.id, actorOf(request));
    const { file: clients } = await loadClients();
    const client = findWorkspace(clients, found.product.id, body['externalId']);
    if (!client) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    const result = await previewFor(found.product.id, found.workspace.brand, channelId, by);
    // Already gone (or never hers): nothing to do.
    if (!result) return json(200, { workspace: await workspaceResponse(clients, client) });
    if (result.preview.running.length > 0) return apiError(409, 'CONFLICT', runningSentence(result.preview.running));
    if (result.preview.onlyChannel && body['confirmOnly'] !== true) return apiError(409, 'ONLY_CHANNEL', 'This is her only connected channel: nothing will be posted until she connects another. Confirm to disconnect it.');
    // The network is asked to forget the access first, best effort; our copy goes either way.
    const key = process.env['CHANNEL_KEY'];
    if (key) await revokeAtNetwork(result.channel, parseKey(key), revokeEnvFromProcess());
    const { file, etag } = await loadChannels();
    await saveChannels(removeChannel(file, channelId), etag);
    // The poster service is told which networks are still connected, so nothing more is drawn for this one.
    forgetConnected();
    const engine = engineOf(found.product.id, found.workspace.brand);
    if (engine) await syncConnected(engine, found.workspace.brand, by);
    return json(200, { workspace: await workspaceResponse(clients, client) });
  } catch (error) {
    return errorResponse(error, 'disconnect the channel');
  }
}

