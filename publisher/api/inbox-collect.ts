/**
 * The regular check of comments (see lib/inbox-collect.ts). Read only. On by default; INBOX_ENABLED=false switches it off.
 *
 * GET /api/inbox-collect   (Authorization: Bearer $CRON_SECRET, from the server timer)
 */
import { describeError, isAuthorized, json } from '../lib/http.js';
import { inboxEnabled, runInboxCheck } from '../lib/inbox-service.js';
import { storeConfigured } from '../lib/store.js';

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['CRON_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!inboxEnabled()) return json(200, { skipped: 'the inbox is switched off (INBOX_ENABLED=false)' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  try {
    const report = await runInboxCheck(Date.now());
    for (const failure of report.failures) console.error(`inbox ${failure.id}: ${failure.reason}`);
    return json(200, { posts: report.posts, newComments: report.comments, needReconnect: report.reconnect.length, failed: report.failures.length });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'the inbox check failed' });
  }
}
