/**
 * The numbers the networks give for a customer's accounts and posts, kept by the daily check.
 *
 * GET /api/v1/analytics?externalId=<workspace>&from=YYYY-MM-DD&to=YYYY-MM-DD   (default: the last 30 days)
 *   {"posts": [{"postId", "channel", "platform", "permalink", "postedAt", "caption", "total", "series": [{"date", ...}]}],
 *    "accounts": [{"channel", "platform", "label", "series": [{"date", ...}], "audience"?, "searchTerms"?, "needs"?, "checkedAt"}],
 *    "hashtags": [{"tag", "posts", "avgReach"}], "checkedAt"}
 *
 * A number a network does not give is absent, never 0. `needs` on an account says why numbers are missing: "reconnect" (connect the account again to give the
 * new permission) or "followers" (too few followers for the audience). Read only, for this product's own workspaces.
 */
import { apiError, errorResponse } from '../../lib/api-error.js';
import { parseRange, viewFor } from '../../lib/analytics.js';
import { json } from '../../lib/http.js';
import { workspaceFor } from '../../lib/product-workspace.js';
import { loadAnalytics } from '../../lib/store.js';
import { analyticsEnabled } from '../analytics-collect.js';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const caller = await workspaceFor(request, params.get('externalId'));
  if (caller instanceof Response) return caller;
  if (!analyticsEnabled()) return apiError(503, 'SERVICE_NOT_CONFIGURED', 'analytics is not switched on yet');
  const range = parseRange(params.get('from'), params.get('to'), Date.now());
  if (typeof range === 'string') return apiError(400, 'INVALID_REQUEST', range);
  try {
    const { file } = await loadAnalytics();
    return json(200, { ...viewFor(file, caller.workspace.brand, range.from, range.to) });
  } catch (error) {
    return errorResponse(error, 'read the analytics');
  }
}
