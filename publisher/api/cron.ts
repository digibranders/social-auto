/**
 * Daily Vercel Cron: publishes the post that is due today to Instagram and to every connected Facebook Page, LinkedIn profile, Google location
 * and customer Instagram account of its client, and sends a push alert when posting fails or a client's schedule is about to run out.
 * Each channel is independent: one failing never stops another.
 *
 * GET /api/cron            (called by Vercel Cron with Authorization: Bearer $CRON_SECRET)
 * GET /api/cron?dryRun=1   prepares everything without publishing (no alerts)
 * GET /api/cron?only=manual   the frequent run: only hand-made posts that became due in the last 15 minutes
 * GET /api/cron?dryRun=1&post=<id>   same, for a named post regardless of its date
 */
import { scheduleData } from '../lib/schedule-source.js';
import { channelLabel, expiringSoon } from '../lib/channels.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { parseProducts } from '../lib/products.js';
import { dispatch, eventForExpiry } from '../lib/webhooks.js';
import { notify } from '../lib/notify.js';
import { applyOverrides } from '../lib/overrides.js';
import { dueManualPosts, duePost, lowQueueWarnings, parseSchedule } from '../lib/schedule.js';
import { sendPost } from '../lib/send-post.js';
import { toScheduled } from '../lib/manual.js';
import { loadChannels, loadClients, loadManual, loadOverrides } from '../lib/store.js';

/**
 * A connection with an end date (LinkedIn gives no refresh; an Instagram token is renewed weekly, so this means the
 * renewal stopped working) is announced to the team and the product, once a day on 7, 3, 1 and 0 days left.
 */
/** How far back the frequent run looks for a hand-made post that became due. */
const FREQUENT_WINDOW_MS = 15 * 60 * 1000;

async function warnAboutExpiringConnections(): Promise<void> {
  try {
    const { file } = await loadChannels();
    // A broken PRODUCTS setting must not stop the team's own warnings.
    const products = (() => {
      try {
        return parseProducts(process.env['PRODUCTS']);
      } catch {
        return [];
      }
    })();
    const { file: added } = products.length > 0 ? await loadClients() : { file: { clients: [] } };
    for (const { channel, days } of expiringSoon(file, Date.now())) {
      const item = eventForExpiry(channel, days, added, Date.now());
      if (item) await dispatch([item], products);
      const name = channel.platform === 'linkedin' ? 'LinkedIn' : 'Instagram';
      await notify({
        title: days === 0 ? `${name} connection ends today` : `${name} connection ends in ${days} day${days === 1 ? '' : 's'}`,
        message:
          `${channelLabel(channel)} (${channel.brand}). Send them a new connect link from the dashboard ` +
          `(Clients, the client, Channels, ${name}) and ask them to press Allow again. Posting to ${name} stops when it ends.`,
        priority: days <= 1 ? 'high' : 'default',
      });
    }
  } catch (error) {
    console.error(describeError(error));
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['CRON_SECRET'])) return json(401, { error: 'unauthorized' });

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';

  try {
    const origin = process.env['PUBLIC_ORIGIN'] ?? url.origin;

    // Dashboard edits are applied on top. If they cannot be read this fails (and alerts) rather than
    // quietly posting the unedited version.
    const { overrides } = await loadOverrides();
    const { file: manualFile } = await loadManual();
    // Planned posts drive the runway warnings; hand-made posts are added for sending only.
    const schedule = applyOverrides(parseSchedule(scheduleData), overrides);
    const everything = applyOverrides([...parseSchedule(scheduleData), ...manualFile.posts.map(toScheduled)], overrides);

    // The frequent run (every few minutes) only sends hand-made posts that were given their own time. It leaves
    // planned posts and the daily warnings to the daily run, and its short window keeps a failing post from alerting all day.
    const onlyManual = url.searchParams.get('only') === 'manual';

    if (!dryRun && !onlyManual) {
      for (const { brand, postsLeft } of lowQueueWarnings(schedule, Date.now())) {
        await notify({
          title: postsLeft === 0 ? 'No scheduled posts left' : 'Schedule running low',
          message:
            `${brand}: ${postsLeft} scheduled post${postsLeft === 1 ? '' : 's'} left after today. ` +
            'The Monday job on the Mac creates more: turn the Mac on if it has been off.',
          priority: postsLeft <= 1 ? 'high' : 'default',
        });
      }
      await warnAboutExpiringConnections();
    }

    // A specific post can be named only in dry-run mode, to test the pipeline before its day.
    const testPostId = dryRun ? url.searchParams.get('post') : null;
    const planned = testPostId ? (everything.find((p) => p.id === testPostId) ?? null) : onlyManual ? null : duePost(schedule, Date.now());
    const due = testPostId
      ? planned ? [planned] : []
      : [...(planned ? [planned] : []), ...dueManualPosts(everything, Date.now(), onlyManual ? FREQUENT_WINDOW_MS : undefined)];
    if (due.length === 0) return json(200, { status: testPostId ? 'post-not-found' : 'nothing-due' });

    const results: Array<Record<string, unknown>> = [];
    let failed = false;
    for (const post of due) {
      const { instagram, facebook, linkedin, google, accounts, failed: postFailed } = await sendPost(post, origin, dryRun);
      failed ||= postFailed;
      results.push({ ...instagram, facebook, linkedin, google, instagramAccounts: accounts });
    }
    // A single result keeps the answer's old shape; several (extra posts the same day) are listed.
    return json(failed ? 500 : 200, results.length === 1 ? (results[0] as Record<string, unknown>) : { posts: results });
  } catch (error) {
    const message = describeError(error);
    console.error(message);
    if (!dryRun) {
      await notify({
        title: 'Instagram post failed',
        message: `${message}\n\nA post stays due for 20 hours. Fix the cause, then ask Claude to re-send it.`,
        priority: 'high',
        tags: 'rotating_light',
      });
    }
    return json(500, { status: 'failed', error: message });
  }
}
