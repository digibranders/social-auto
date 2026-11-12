/**
 * The regular check of the networks' numbers (see lib/analytics-collect.ts). Read only: nothing is written to any network.
 * On by default; ANALYTICS_ENABLED=false switches it off.
 *
 * GET /api/analytics-collect   (Authorization: Bearer $CRON_SECRET, from the server timer)
 */
import { describeError, isAuthorized, json } from '../lib/http.js';
import { analyticsEnabled, runAnalyticsCheck } from '../lib/analytics-service.js';
import { storeConfigured } from '../lib/store.js';

export { analyticsEnabled };

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['CRON_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!analyticsEnabled()) return json(200, { skipped: 'analytics is switched off (ANALYTICS_ENABLED=false)' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  try {
    const report = await runAnalyticsCheck(Date.now());
    return json(200, { posts: report.posts, accounts: report.accounts, failed: report.failures.length });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'the analytics check failed' });
  }
}
