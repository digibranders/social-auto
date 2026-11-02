/**
 * Saves the Facebook Pages a person approved for a client. Called only by the dashboard's server (EDIT_SECRET),
 * which passes on the one-time code Facebook gave after the approval. Page tokens are encrypted before they are
 * stored and are never returned.
 *
 * POST /api/facebook-connect   {"code": "...", "redirectUri": "...", "brand": "brandbasket"}
 */
import { schedule as scheduleData } from '../../data/schedule.js';
import { addFacebookPages } from '../../lib/channels.js';
import { parseKey } from '../../lib/crypto.js';
import { describeError, isAuthorized, json, requireEnv } from '../../lib/http.js';
import { exchangeCode, FacebookApiError, listPages, longLivedUserToken } from '../../lib/facebook.js';
import { allBrands } from '../../lib/clients.js';
import { parseSchedule } from '../../lib/schedule.js';
import { loadChannels, loadClients, saveChannels, storeConfigured } from '../../lib/store.js';

/** The clients the content job plans posts for. */
const plannedBrands = (): string[] => parseSchedule(scheduleData).map((p) => p.brand ?? 'default');

const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const { code, redirectUri, brand } = body ?? {};
  if (typeof code !== 'string' || typeof redirectUri !== 'string' || typeof brand !== 'string' || !code || !redirectUri || !brand) {
    return json(400, { error: 'code, redirectUri and brand are required' });
  }
  const knownBrands = allBrands(plannedBrands(), (await loadClients()).file);
  if (!knownBrands.has(brand)) return json(400, { error: `unknown client "${brand}"` });

  try {
    const key = parseKey(process.env['CHANNEL_KEY']);
    const app = { appId: requireEnv('FACEBOOK_APP_ID'), appSecret: requireEnv('FACEBOOK_APP_SECRET') };
    const userToken = await longLivedUserToken(app, await exchangeCode(app, redirectUri, code));
    const pages = await listPages(userToken);
    if (pages.length === 0) return json(422, { error: 'No Pages were approved. Choose at least one Page you manage.' });

    const { file, etag } = await loadChannels();
    await saveChannels(addFacebookPages(file, brand, pages, key, Date.now()), etag);
    return json(200, { pages: pages.map((p) => ({ id: p.id, name: p.name })) });
  } catch (error) {
    console.error(describeError(error));
    if (error instanceof FacebookApiError) return json(502, { error: 'Facebook did not accept the approval. Try connecting again.' });
    return json(500, { error: 'could not save the connection' });
  }
}
