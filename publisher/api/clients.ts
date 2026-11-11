/**
 * Clients added in the dashboard. Called only by the dashboard's server (EDIT_SECRET).
 *
 * POST /api/clients?action=add       body: {"name": "Brand Basket", "website": "brandbasket.in"}   answers {"brand": "brand-basket"}  (website is optional)
 * POST /api/clients?action=set-website  body: {"brand": "brand-basket", "website": "brandbasket.in"}  (an empty website clears it)
 * POST /api/clients?action=add-plan     body: {"brand": "brand-basket", "plan": {...}}  (one more plan: what to post, where and for how long; "plan.channelIds" names the exact account for each platform, and is filled in when the client has only one account on a platform)
 * POST /api/clients?action=set-limit    body: {"brand": "brand-basket", "limit": 3}  (posters a week the website may make for each channel)
 * POST /api/clients?action=set-logo-required  body: {"brand": "brand-basket", "required": true}  (every poster must carry the website's real logo)
 * POST /api/clients?action=set-approval-mode  body: {"brand": "brand-basket", "mode": "auto"}  ("manual": a person approves each poster; "auto": a poster that passes the automatic checks is approved by the system)
 * POST /api/clients?action=set-spend-cap  body: {"brand": "brand-basket", "cap": 5}  (what the AI may cost for the client in a calendar month, in dollars; null goes back to the default limit)
 * POST /api/clients?action=remove-plan  body: {"brand": "brand-basket", "index": 0}  (stops making posters for that plan)
 * POST /api/clients?action=set-brands-default  body: {"value": 2}  (how many brands a product customer may have unless told otherwise, 1 to 4)
 * POST /api/clients?action=set-brands-allowed  body: {"product": "brandbasket", "group": "<customer id>", "value": 3}  (one customer's own number, 1 to 4; null goes back to the default)
 * POST /api/clients?action=remove    body: {"brand": "brand-basket"}  (only an added client with no channels or extra posts)
 */
import { scheduleData } from '../lib/schedule-source.js';
import { channelsFor } from '../lib/channels.js';
import { addClient, addPlan, isBrandSlug, isExternalId, removePlan, workspacesInGroup, setApprovalMode, setRequireAuthenticLogo, setSpendCap, setWebsite, setWeeklyLimit } from '../lib/clients.js';
import { BrandSettingsError, withDefaultBrands, withGroupBrands } from '../lib/brands.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { EditError } from '../lib/overrides.js';
import { parseSchedule } from '../lib/schedule.js';
import { loadBrandSettings, loadChannels, loadClients, loadManual, saveBrandSettings, saveClients, storeConfigured } from '../lib/store.js';

const MAX_BODY_BYTES = 4 * 1024;

const plannedBrands = (): Set<string> => new Set(parseSchedule(scheduleData).map((p) => p.brand ?? 'default'));

async function add(body: Record<string, unknown>): Promise<Response> {
  const { file, etag } = await loadClients();
  const planned = plannedBrands();
  const result = addClient(file, body['name'], new Set([...planned, ...file.clients.map((c) => c.brand)]), Date.now(), body['website'], body['plan'], body['requireAuthenticLogo']);
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

async function plan(body: Record<string, unknown>, change: 'add' | 'remove'): Promise<Response> {
  const brand = body['brand'];
  if (!isBrandSlug(brand)) throw new EditError('unknown client');
  const [{ file, etag }, { file: channels }] = await Promise.all([loadClients(), loadChannels()]);
  await saveClients(change === 'add' ? addPlan(file, brand, body['plan'], Date.now(), channels.channels) : removePlan(file, brand, body['index']), etag);
  return json(200, { ok: true });
}

async function limit(body: Record<string, unknown>): Promise<Response> {
  const brand = body['brand'];
  if (!isBrandSlug(brand)) throw new EditError('unknown client');
  const { file, etag } = await loadClients();
  await saveClients(setWeeklyLimit(file, brand, body['limit']), etag);
  return json(200, { ok: true });
}

async function logoRequired(body: Record<string, unknown>): Promise<Response> {
  const brand = body['brand'];
  if (!isBrandSlug(brand)) throw new EditError('unknown client');
  const { file, etag } = await loadClients();
  await saveClients(setRequireAuthenticLogo(file, brand, body['required']), etag);
  return json(200, { ok: true });
}

async function spendCap(body: Record<string, unknown>): Promise<Response> {
  const brand = body['brand'];
  if (!isBrandSlug(brand)) throw new EditError('unknown client');
  const { file, etag } = await loadClients();
  await saveClients(setSpendCap(file, brand, body['cap'] ?? null), etag);
  return json(200, { ok: true });
}

async function approvalMode(body: Record<string, unknown>): Promise<Response> {
  const brand = body['brand'];
  if (!isBrandSlug(brand)) throw new EditError('unknown client');
  const { file, etag } = await loadClients();
  await saveClients(setApprovalMode(file, brand, body['mode']), etag);
  return json(200, { ok: true });
}

/** Who is recorded for a change: the dashboard has one login, so one fixed name. */
const STAFF = 'owner';

async function brandsDefault(body: Record<string, unknown>): Promise<Response> {
  const { settings, etag } = await loadBrandSettings();
  await saveBrandSettings(withDefaultBrands(settings, body['value'], STAFF, Date.now()), etag);
  return json(200, { ok: true });
}

async function brandsAllowed(body: Record<string, unknown>): Promise<Response> {
  const { product, group } = body;
  if (typeof product !== 'string' || !/^[a-z][a-z0-9]{1,19}$/.test(product) || !isExternalId(group)) throw new EditError('unknown customer');
  const { file } = await loadClients();
  if (workspacesInGroup(file, product, group).length === 0) throw new EditError('no such customer', 404);
  const { settings, etag } = await loadBrandSettings();
  await saveBrandSettings(withGroupBrands(settings, product, group, body['value'] ?? null, STAFF, Date.now()), etag);
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
    if (action === 'add-plan') return await plan(body, 'add');
    if (action === 'remove-plan') return await plan(body, 'remove');
    if (action === 'set-limit') return await limit(body);
    if (action === 'set-logo-required') return await logoRequired(body);
    if (action === 'set-approval-mode') return await approvalMode(body);
    if (action === 'set-spend-cap') return await spendCap(body);
    if (action === 'set-brands-default') return await brandsDefault(body);
    if (action === 'set-brands-allowed') return await brandsAllowed(body);
    if (action === 'remove') return await remove(body);
    return json(400, { error: 'unknown action' });
  } catch (error) {
    if (error instanceof EditError || error instanceof BrandSettingsError) return json(error instanceof EditError ? error.status : 400, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save the change' });
  }
}
