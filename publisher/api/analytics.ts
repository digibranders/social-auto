/**
 * A client's analytics for the team's dashboard (the dashboard's server adds the secret; the browser never sees it).
 *
 * GET /api/analytics?brand=<client id>&from=YYYY-MM-DD&to=YYYY-MM-DD   (Authorization: Bearer $STATUS_SECRET)
 *   {"enabled": boolean, ...the same numbers as GET /api/v1/analytics}
 */
import { parseRange, viewFor } from '../lib/analytics.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { loadAnalytics, storeConfigured } from '../lib/store.js';
import { analyticsEnabled } from './analytics-collect.js';

const BRAND = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/;

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['STATUS_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  const params = new URL(request.url).searchParams;
  const brand = params.get('brand') ?? '';
  if (!BRAND.test(brand)) return json(400, { error: 'brand is required' });
  const range = parseRange(params.get('from'), params.get('to'), Date.now());
  if (typeof range === 'string') return json(400, { error: range });
  try {
    const { file } = await loadAnalytics();
    return json(200, { enabled: analyticsEnabled(), ...viewFor(file, brand, range.from, range.to) });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'could not read the analytics' });
  }
}
