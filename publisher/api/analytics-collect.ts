/**
 * The daily check of the networks' numbers (see lib/analytics-collect.ts). Read only: nothing is written to any network.
 * On by default; ANALYTICS_ENABLED=false switches it off.
 *
 * GET /api/analytics-collect   (Authorization: Bearer $CRON_SECRET, from the server timer)
 */
import { collectAnalytics, type AnalyticsReaders, type TeamInstagram } from '../lib/analytics-collect.js';
import { facebookAccount, facebookPost, googleLocation, instagramAccount, instagramPost } from '../lib/analytics-fetch.js';
import { parseKey } from '../lib/crypto.js';
import { accessTokenFor } from '../lib/google.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { toScheduled } from '../lib/manual.js';
import { parseSchedule } from '../lib/schedule.js';
import { scheduleData } from '../lib/schedule-source.js';
import { loadAnalytics, loadChannels, loadManual, loadPosted, saveAnalytics, storeConfigured } from '../lib/store.js';

export const analyticsEnabled = (): boolean => process.env['ANALYTICS_ENABLED'] !== 'false';

const readers: AnalyticsReaders = {
  instagramPost: (id, token) => instagramPost(id, token),
  instagramAccount: (id, token, today) => instagramAccount(id, token, today),
  facebookPost: (id, token) => facebookPost(id, token),
  facebookAccount: (id, token, today) => facebookAccount(id, token, today),
  googleToken: accessTokenFor,
  googleLocation: (location, token, since, until) => googleLocation(location, token, since, until),
};

/** The team's own Instagram account, when its settings are there, and which client each of its posts belongs to. */
async function teamInstagram(): Promise<TeamInstagram | null> {
  const token = process.env['INSTAGRAM_TOKEN'];
  const userId = process.env['INSTAGRAM_USER_ID'];
  if (!token || !userId) return null;
  const { file: manual } = await loadManual();
  const brands = new Map<string, string>();
  for (const p of [...parseSchedule(scheduleData), ...manual.posts.map(toScheduled)]) brands.set(p.id, p.brand ?? 'default');
  return { userId, token, brandOfPost: (postId) => brands.get(postId) };
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['CRON_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!analyticsEnabled()) return json(200, { skipped: 'analytics is switched off (ANALYTICS_ENABLED=false)' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  try {
    const key = parseKey(process.env['CHANNEL_KEY']);
    const clientId = process.env['GOOGLE_CLIENT_ID'];
    const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];
    const [{ file: channels }, { log }, { file, etag }] = await Promise.all([loadChannels(), loadPosted(), loadAnalytics()]);
    const result = await collectAnalytics({
      file,
      channels: channels.channels,
      posted: log,
      key,
      googleApp: clientId && clientSecret ? { clientId, clientSecret } : null,
      readers,
      now: Date.now(),
      team: await teamInstagram(),
    });
    await saveAnalytics(result.file, etag);
    for (const failure of result.report.failures) console.error(`analytics ${failure.id}: ${failure.reason}`);
    return json(200, { posts: result.report.posts, accounts: result.report.accounts, failed: result.report.failures.length });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'the analytics check failed' });
  }
}
