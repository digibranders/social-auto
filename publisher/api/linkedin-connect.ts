/**
 * Saves a LinkedIn profile a person approved for a client. Called only by the dashboard's server (EDIT_SECRET),
 * which passes on the one-time code LinkedIn gave after the approval. The access token is encrypted before it is
 * stored and is never returned.
 *
 * POST /api/linkedin-connect   {"code": "...", "redirectUri": "...", "brand": "brandbasket"}
 */
import { schedule as scheduleData } from '../data/schedule.js';
import { addLinkedInMember } from '../lib/channels.js';
import { parseKey } from '../lib/crypto.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import { exchangeCode, LinkedInApiError, memberOf } from '../lib/linkedin.js';
import { allBrands } from '../lib/clients.js';
import { parseSchedule } from '../lib/schedule.js';
import { loadChannels, loadClients, saveChannels, storeConfigured } from '../lib/store.js';

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
    const app = { clientId: requireEnv('LINKEDIN_CLIENT_ID'), clientSecret: requireEnv('LINKEDIN_CLIENT_SECRET') };
    const token = await exchangeCode(app, redirectUri, code);
    const member = await memberOf(token.accessToken);

    const { file, etag } = await loadChannels();
    await saveChannels(addLinkedInMember(file, brand, member, token.accessToken, token.expiresInSeconds, key, Date.now()), etag);
    return json(200, { member: { name: member.name }, expiresInDays: Math.floor(token.expiresInSeconds / 86_400) });
  } catch (error) {
    console.error(describeError(error));
    if (error instanceof LinkedInApiError) return json(502, { error: 'LinkedIn did not accept the approval. Try connecting again.' });
    return json(500, { error: 'could not save the connection' });
  }
}
