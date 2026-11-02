/**
 * Weekly Vercel Cron: renews the Instagram token, and every customer's connected Instagram token, so none reaches its 60-day expiry.
 *
 * Instagram extends the same token's life when it is refreshed. If it ever hands back a different
 * token instead, the saved one keeps working until it expires, but it must be replaced by hand,
 * so this sends an alert (never the token itself).
 *
 * GET /api/refresh   (called by Vercel Cron with Authorization: Bearer $CRON_SECRET)
 */
import { channelToken, renewInstagramToken } from '../lib/channels.js';
import { parseKey } from '../lib/crypto.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import { refreshToken } from '../lib/instagram.js';
import { notify } from '../lib/notify.js';
import { loadChannels, saveChannels } from '../lib/store.js';

const RENEW_HELP =
  'Generate a new token on the Meta developer page (Instagram, API setup with Instagram login) ' +
  'and save it as INSTAGRAM_TOKEN in the Vercel project.';

/** Instagram only renews a token that is at least a day old and has not ended. */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Renews every customer Instagram connection, so none reaches its 60-day end. A connection that cannot be renewed
 * is left as it is: the daily job warns the team and the product as its end date nears.
 */
async function renewCustomerAccounts(now: number): Promise<{ renewed: number; failed: string[] }> {
  const { file, etag } = await loadChannels();
  const accounts = file.channels.filter((c) => c.platform === 'instagram');
  if (accounts.length === 0) return { renewed: 0, failed: [] };
  const key = parseKey(process.env['CHANNEL_KEY']);
  let next = file;
  let renewed = 0;
  const failed: string[] = [];
  for (const account of accounts) {
    try {
      if (Date.parse(account.expiresAt) <= now) throw new Error('the connection has already ended');
      if (now - Date.parse(account.connectedAt) < MIN_AGE_MS) continue;
      const fresh = await refreshToken(channelToken(account, key));
      next = renewInstagramToken(next, account.id, fresh.token, fresh.expiresInDays * 86_400, key, now);
      renewed += 1;
    } catch (error) {
      console.error(`${account.id}: ${describeError(error)}`);
      failed.push(account.id);
    }
  }
  if (renewed > 0) await saveChannels(next, etag);
  return { renewed, failed };
}

/** The team's own Instagram token (set in the environment). Never throws: the customers' renewals must still run. */
async function renewTeamToken(): Promise<{ status: 'renewed' | 'rotated' | 'failed'; expiresInDays?: number; error?: string }> {
  try {
    const current = requireEnv('INSTAGRAM_TOKEN');
    const refreshed = await refreshToken(current);
    if (refreshed.token !== current) {
      await notify({
        title: 'Instagram token changed',
        message: `Instagram issued a new token while renewing. The saved one works for now but will expire. ${RENEW_HELP}`,
        priority: 'high',
      });
      return { status: 'rotated', expiresInDays: refreshed.expiresInDays };
    }
    console.log(`token renewed, valid for ${refreshed.expiresInDays} more days`);
    return { status: 'renewed', expiresInDays: refreshed.expiresInDays };
  } catch (error) {
    const message = describeError(error);
    console.error(message);
    await notify({
      title: 'Instagram token renewal failed',
      message: `${message}\n\nPosting stops when the token expires or is revoked. ${RENEW_HELP}`,
      priority: 'high',
      tags: 'rotating_light',
    });
    return { status: 'failed', error: message };
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['CRON_SECRET'])) return json(401, { error: 'unauthorized' });

  const team = await renewTeamToken();
  let customers: { renewed: number; failed: string[] } | { error: string };
  try {
    customers = await renewCustomerAccounts(Date.now());
    if ('failed' in customers && customers.failed.length > 0) {
      await notify({
        title: 'Instagram renewal failed for a customer',
        message: `${customers.failed.length} customer connection${customers.failed.length === 1 ? '' : 's'} could not be renewed (${customers.failed.join(', ')}). The team is warned as each one nears its end.`,
        priority: 'default',
      });
    }
  } catch (error) {
    console.error(describeError(error));
    customers = { error: 'could not renew the customer connections' };
  }
  const failed = team.status === 'failed' || 'error' in customers;
  return json(failed ? 500 : 200, { ...team, customers });
}
