/**
 * "Refresh now" on a client's Analytics tab: reads that client's numbers again, skipping anything read in the last few minutes, so pressing it twice costs
 * the networks nothing. Read only. Called by the dashboard's server with the write secret.
 *
 * POST /api/analytics-refresh   {"brand": "<client id>"}   (Authorization: Bearer $EDIT_SECRET)
 *   {"posts", "accounts", "failed"}
 */
import { describeError, isAuthorized, json } from '../lib/http.js';
import { analyticsEnabled, runAnalyticsCheck } from '../lib/analytics-service.js';
import { storeConfigured } from '../lib/store.js';

const BRAND = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;
/** Anything read within this long is not read again, however often the button is pressed. */
export const REFRESH_GAP_MS = 5 * 60_000;

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!analyticsEnabled()) return json(503, { error: 'analytics is switched off' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > 1024) return json(413, { error: 'request too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const brand = body?.['brand'];
  if (typeof brand !== 'string' || !BRAND.test(brand)) return json(400, { error: 'brand is required' });
  try {
    const report = await runAnalyticsCheck(Date.now(), { brand, minRereadMs: REFRESH_GAP_MS });
    return json(200, { posts: report.posts, accounts: report.accounts, failed: report.failures.length });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'the numbers could not be refreshed' });
  }
}
