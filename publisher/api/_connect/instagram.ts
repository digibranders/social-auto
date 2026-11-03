/**
 * Saves an Instagram account a person approved for a client. Called only by the dashboard's server (EDIT_SECRET),
 * which passes on the one-time code Instagram gave after the approval. The token is encrypted before it is stored
 * and is never returned.
 *
 * POST /api/instagram-connect   {"code": "...", "redirectUri": "...", "brand": "brandbasket"}
 */
import { scheduleData } from '../../lib/schedule-source.js';
import { addInstagramAccount } from '../../lib/channels.js';
import { parseKey } from '../../lib/crypto.js';
import { describeError, isAuthorized, json, requireEnv } from '../../lib/http.js';
import { accountOf, exchangeCode, InstagramApiError, longLivedToken } from '../../lib/instagram.js';
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
    const app = { appId: requireEnv('INSTAGRAM_APP_ID'), appSecret: requireEnv('INSTAGRAM_APP_SECRET') };
    const short = await exchangeCode(app, redirectUri, code);
    const long = await longLivedToken(app, short.accessToken);
    const account = await accountOf(long.accessToken);

    const { file, etag } = await loadChannels();
    await saveChannels(addInstagramAccount(file, brand, account, long.accessToken, long.expiresInSeconds, key, Date.now()), etag);
    return json(200, { account: { username: account.username }, expiresInDays: Math.floor(long.expiresInSeconds / 86_400) });
  } catch (error) {
    console.error(describeError(error));
    if (error instanceof InstagramApiError) return json(502, { error: 'Instagram did not accept the approval. Try connecting again.' });
    return json(500, { error: 'could not save the connection' });
  }
}
