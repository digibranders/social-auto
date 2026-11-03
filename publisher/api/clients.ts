/**
 * Clients added in the dashboard. Called only by the dashboard's server (EDIT_SECRET).
 *
 * POST /api/clients?action=add       body: {"name": "Brand Basket", "website": "brandbasket.in"}   answers {"brand": "brand-basket"}  (website is optional)
 * POST /api/clients?action=set-website  body: {"brand": "brand-basket", "website": "brandbasket.in"}  (an empty website clears it)
 * POST /api/clients?action=remove    body: {"brand": "brand-basket"}  (only an added client with no channels or extra posts)
 */
import { scheduleData } from '../lib/schedule-source.js';
import { channelsFor } from '../lib/channels.js';
import { addClient, isBrandSlug, setWebsite } from '../lib/clients.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { EditError } from '../lib/overrides.js';
import { parseSchedule } from '../lib/schedule.js';
import { loadChannels, loadClients, loadManual, saveClients, storeConfigured } from '../lib/store.js';

const MAX_BODY_BYTES = 2 * 1024;

const plannedBrands = (): Set<string> => new Set(parseSchedule(scheduleData).map((p) => p.brand ?? 'default'));

async function add(body: Record<string, unknown>): Promise<Response> {
  const { file, etag } = await loadClients();
  const planned = plannedBrands();
  const result = addClient(file, body['name'], new Set([...planned, ...file.clients.map((c) => c.brand)]), Date.now(), body['website']);
  await saveClients(result.file, etag);
  return json(200, { brand: result.brand });
}

async function website(body: Record<string, unknown>): Promise<Response> {
  const brand = body['brand'];
  if (!isBrandSlug(brand)) throw new EditError('unknown client');
  const { file, etag } = await loadClients();
  await saveClients(setWebsite(file, brand, body['website']), etag);
  return json(200, { ok: true });
}

async function remove(body: Record<string, unknown>): Promise<Response> {
  const brand = body['brand'];
  if (!isBrandSlug(brand)) throw new EditError('unknown client');
  const [{ file, etag }, { file: channels }, { file: manual }] = await Promise.all([loadClients(), loadChannels(), loadManual()]);
  if (!file.clients.some((c) => c.brand === brand)) throw new EditError('only a client added in the dashboard can be removed', 404);
  if (channelsFor(channels, brand).length > 0) throw new EditError('disconnect this client\'s channels first', 409);
  if (manual.posts.some((p) => p.brand === brand)) throw new EditError('delete this client\'s extra posts first', 409);
  await saveClients({ clients: file.clients.filter((c) => c.brand !== brand) }, etag);
  return json(200, { ok: true });
}

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return json(400, { error: 'send JSON' });
  const action = new URL(request.url).searchParams.get('action');
  try {
    if (action === 'add') return await add(body);
    if (action === 'set-website') return await website(body);
    if (action === 'remove') return await remove(body);
    return json(400, { error: 'unknown action' });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save the change' });
  }
}
