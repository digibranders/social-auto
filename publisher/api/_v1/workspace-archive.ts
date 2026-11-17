/**
 * Putting a brand away, and bringing it back.
 *
 * POST /api/v1/workspaces/archive   {"externalId", "archived": true | false}   answers {"workspace"}
 *
 * A brand that is put away is kept but PAUSED: nothing new is sent, written or drawn for it (calls that spend answer 409 WORKSPACE_ARCHIVED), its data stays
 * readable, and it no longer counts against the customer's brands, so it frees a slot. Bringing it back needs a free slot (409 BRAND_LIMIT_REACHED). Doing
 * either again is safe. A pause the team made is never lifted by bringing a brand back.
 */
import { assertRoomForBrand, brandsAllowed } from '../../lib/brands.js';
import { channelsFor } from '../../lib/channels.js';
import { findWorkspace, groupOf, isExternalId, setArchived, workspacesInGroup } from '../../lib/clients.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { billingView, planNotices } from '../../lib/billing.js';
import { brandIsPaused, setPause } from '../../lib/pauses.js';
import { productOf } from '../../lib/product-request.js';
import { loadBrandSettings, loadChannels, loadClients, loadPauses, savePauses, saveClients, storeConfigured } from '../../lib/store.js';
import { noticesFor } from '../../lib/workspace-notices.js';

const MAX_BODY_BYTES = 1024;

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  if (!isExternalId(body['externalId'])) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  if (typeof body['archived'] !== 'boolean') return apiError(400, 'INVALID_REQUEST', 'archived must be true or false');
  const archive = body['archived'];
  try {
    const [{ file, etag }, { file: pauses, etag: pauseEtag }, { settings }] = await Promise.all([loadClients(), loadPauses(), loadBrandSettings()]);
    const client = findWorkspace(file, product.id, body['externalId']);
    if (!client) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    if ((client.archived === true) !== archive) {
      if (archive) {
        // Putting it away pauses it; only a pause that this made is lifted when it comes back.
        const alreadyPaused = brandIsPaused(pauses, client.brand);
        if (!alreadyPaused) await savePauses(setPause(pauses, 'brand', client.brand, true), pauseEtag);
        await saveClients(setArchived(file, client.brand, true, !alreadyPaused), etag);
      } else {
        const group = groupOf(client) as string;
        assertRoomForBrand(workspacesInGroup(file, product.id, group).filter((w) => w.brand !== client.brand), brandsAllowed(settings, product.id, group), false);
        await saveClients(setArchived(file, client.brand, false, false), etag);
        if (client.archivedPause) await savePauses(setPause(pauses, 'brand', client.brand, false), pauseEtag);
      }
    }
    const [{ file: after }, { file: nowPaused }, { file: channels }] = await Promise.all([loadClients(), loadPauses(), loadChannels()]);
    const updated = findWorkspace(after, product.id, body['externalId']);
    if (!updated) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    const mine = channelsFor(channels, updated.brand);
    return json(200, { workspace: { id: updated.brand, externalId: updated.externalId ?? null, name: updated.name ?? null, website: updated.website ?? null, archived: updated.archived === true, paused: brandIsPaused(nowPaused, updated.brand), billing: billingView(nowPaused, updated.brand, Date.now()), notices: [...noticesFor(mine, nowPaused.all || nowPaused.brands.includes(updated.brand), Date.now()), ...planNotices(billingView(nowPaused, updated.brand, Date.now()))] } });
  } catch (error) {
    return errorResponse(error, 'change the brand');
  }
}
