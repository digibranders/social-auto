/**
 * Weekly Vercel Cron: renews the Instagram token so it never reaches its 60-day expiry.
 *
 * Instagram extends the same token's life when it is refreshed. If it ever hands back a different
 * token instead, the saved one keeps working until it expires, but it must be replaced by hand,
 * so this sends an alert (never the token itself).
 *
 * GET /api/refresh   (called by Vercel Cron with Authorization: Bearer $CRON_SECRET)
 */
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import { refreshToken } from '../lib/instagram.js';
import { notify } from '../lib/notify.js';

const RENEW_HELP =
  'Generate a new token on the Meta developer page (Instagram, API setup with Instagram login) ' +
  'and save it as INSTAGRAM_TOKEN in the Vercel project.';

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['CRON_SECRET'])) return json(401, { error: 'unauthorized' });

  try {
    const current = requireEnv('INSTAGRAM_TOKEN');
    const refreshed = await refreshToken(current);
    if (refreshed.token !== current) {
      await notify({
        title: 'Instagram token changed',
        message: `Instagram issued a new token while renewing. The saved one works for now but will expire. ${RENEW_HELP}`,
        priority: 'high',
      });
      return json(200, { status: 'rotated', expiresInDays: refreshed.expiresInDays });
    }
    console.log(`token renewed, valid for ${refreshed.expiresInDays} more days`);
    return json(200, { status: 'renewed', expiresInDays: refreshed.expiresInDays });
  } catch (error) {
    const message = describeError(error);
    console.error(message);
    await notify({
      title: 'Instagram token renewal failed',
      message: `${message}\n\nPosting stops when the token expires or is revoked. ${RENEW_HELP}`,
      priority: 'high',
      tags: 'rotating_light',
    });
    return json(500, { status: 'failed', error: message });
  }
}
