/**
 * Saves an Instagram account a person approved for a client. Called only by the dashboard's server (EDIT_SECRET),
 * which passes on the one-time code Instagram gave after the approval. The token is encrypted before it is stored
 * and is never returned.
 *
 * POST /api/instagram-connect   {"code": "...", "redirectUri": "...", "brand": "brandbasket"}
 */
import { accountInUse, checkHolders, holderOptions } from '../../lib/channel-holder.js';
import { scheduleData } from '../../lib/schedule-source.js';
import { addInstagramAccount, type ChannelFile } from '../../lib/channels.js';
import { parseKey } from '../../lib/crypto.js';
import { describeError, isAuthorized, json, requireEnv } from '../../lib/http.js';
import { accountOf, accountsOf, exchangeCode, exchangeFacebookCode, InstagramApiError, longLivedToken, subscribeAccountWebhooks, unifiedLogin, type InstagramAccount } from '../../lib/instagram.js';
import { allBrands } from '../../lib/clients.js';
import { parseSchedule } from '../../lib/schedule.js';
import { loadChannels, loadClients, saveChannels, storeConfigured } from '../../lib/store.js';

/** The clients the content job plans posts for. */
const plannedBrands = (): string[] => parseSchedule(scheduleData).map((p) => p.brand ?? 'default');

const MAX_BODY_BYTES = 8 * 1024;

interface Approved {
  accounts: InstagramAccount[];
  token: string;
  /** Seconds the token lasts, or null when it never ends (Facebook login). */
  expiresInSeconds: number | null;
}

/** Instagram's own login: one account, a token of about 60 days that the weekly job renews. */
async function approveWithInstagram(code: string, redirectUri: string): Promise<Approved> {
  const app = { appId: requireEnv('INSTAGRAM_APP_ID'), appSecret: requireEnv('INSTAGRAM_APP_SECRET') };
  const short = await exchangeCode(app, redirectUri, code);
  const long = await longLivedToken(app, short.accessToken);
  return { accounts: [await accountOf(long.accessToken)], token: long.accessToken, expiresInSeconds: long.expiresInSeconds };
}

/** Facebook login (INSTAGRAM_LOGIN=facebook): every account the person handed over in the chooser; the token does not expire. */
async function approveWithFacebook(code: string, redirectUri: string): Promise<Approved> {
  const app = { appId: requireEnv('FACEBOOK_APP_ID'), appSecret: requireEnv('FACEBOOK_APP_SECRET') };
  const token = await exchangeFacebookCode(app, redirectUri, code);
  const accounts = await accountsOf(token);
  if (accounts.length === 0) throw new NoAccountsError();
  return { accounts, token, expiresInSeconds: null };
}

/** The person approved, but chose no Instagram account (or it is not a professional account). */
class NoAccountsError extends Error {}

/** Saves every approved account for the client, replacing an earlier connection of the same account. */
const withAccounts = (file: ChannelFile, brand: string, approved: Approved, key: Buffer, now: number): ChannelFile =>
  approved.accounts.reduce((next, account) => addInstagramAccount(next, brand, account, approved.token, approved.expiresInSeconds, key, now), file);

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const { code, redirectUri, brand } = body ?? {};
  if (typeof code !== 'string' || typeof redirectUri !== 'string' || typeof brand !== 'string' || !code || !redirectUri || !brand) {
    return json(400, { error: 'code, redirectUri and brand are required' });
  }
  const clients = (await loadClients()).file;
  const knownBrands = allBrands(plannedBrands(), clients);
  if (!knownBrands.has(brand)) return json(400, { error: `unknown client "${brand}"` });

  try {
    const key = parseKey(process.env['CHANNEL_KEY']);
    const approved = unifiedLogin() ? await approveWithFacebook(code, redirectUri) : await approveWithInstagram(code, redirectUri);

    const { file, etag } = await loadChannels();
    const verdict = checkHolders(file, clients, brand, approved.accounts.map((a) => `instagram:${a.userId}`), holderOptions(body));
    if (!verdict.ok) return accountInUse(verdict);
    await saveChannels(withAccounts(file, brand, approved, key, Date.now()), etag);
    for (const acc of approved.accounts) {
      await subscribeAccountWebhooks(acc.userId, approved.token).catch((err) => {
        console.error(`Instagram webhook subscription failed for ${brand} (${acc.userId}): ${describeError(err)}`);
      });
    }
    return json(200, {
      account: { username: approved.accounts[0]?.username },
      accounts: approved.accounts.map((a) => ({ username: a.username })),
      expiresInDays: approved.expiresInSeconds === null ? null : Math.floor(approved.expiresInSeconds / 86_400),
    });
  } catch (error) {
    console.error(describeError(error));
    if (error instanceof NoAccountsError) return json(422, { error: 'No Instagram account was chosen. Connect again and pick an Instagram professional account.' });
    if (error instanceof InstagramApiError) return json(502, { error: 'Instagram did not accept the approval. Try connecting again.' });
    return json(500, { error: 'could not save the connection' });
  }
}
