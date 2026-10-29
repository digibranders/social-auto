/**
 * Daily Vercel Cron: publishes the post that is due today to Instagram, and sends a push alert
 * when posting fails or a client's schedule is about to run out.
 *
 * GET /api/cron            (called by Vercel Cron with Authorization: Bearer $CRON_SECRET)
 * GET /api/cron?dryRun=1   prepares the Instagram container without publishing it (no alerts)
 * GET /api/cron?dryRun=1&post=<id>   same, for a named post regardless of its date
 */
import { schedule as scheduleData } from '../data/schedule.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import {
  createImageContainer,
  permalink,
  publishContainer,
  recentMedia,
  waitUntilReady,
} from '../lib/instagram.js';
import { notify } from '../lib/notify.js';
import { duePost, lowQueueWarnings, parseSchedule, sameCaption } from '../lib/schedule.js';

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['CRON_SECRET'])) return json(401, { error: 'unauthorized' });

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';

  try {
    const token = requireEnv('INSTAGRAM_TOKEN');
    const userId = requireEnv('INSTAGRAM_USER_ID');
    const origin = process.env['PUBLIC_ORIGIN'] ?? url.origin;

    // Imported module: bundled with the function, not served publicly.
    const schedule = parseSchedule(scheduleData);

    if (!dryRun) {
      for (const { brand, postsLeft } of lowQueueWarnings(schedule, Date.now())) {
        await notify({
          title: postsLeft === 0 ? 'No scheduled posts left' : 'Schedule running low',
          message:
            `${brand}: ${postsLeft} scheduled post${postsLeft === 1 ? '' : 's'} left after today. ` +
            'The Monday job on the Mac creates more: turn the Mac on if it has been off.',
          priority: postsLeft <= 1 ? 'high' : 'default',
        });
      }
    }

    // A specific post can be named only in dry-run mode, to test the pipeline before its day.
    const testPostId = dryRun ? url.searchParams.get('post') : null;
    const post = testPostId ? (schedule.find((p) => p.id === testPostId) ?? null) : duePost(schedule, Date.now());
    if (!post) return json(200, { status: testPostId ? 'post-not-found' : 'nothing-due' });

    const alreadyLive = (await recentMedia(userId, token)).find((m) => sameCaption(m.caption, post.caption));
    if (alreadyLive) return json(200, { status: 'already-published', post: post.id, media: alreadyLive.id });

    const containerId = await createImageContainer(userId, token, `${origin}${post.image}`, post.caption);
    await waitUntilReady(containerId, token);
    if (dryRun) return json(200, { status: 'dry-run-ready', post: post.id, container: containerId });

    const mediaId = await publishContainer(userId, token, containerId);
    const link = await permalink(mediaId, token).catch(() => '');
    console.log(`published ${post.id} as ${mediaId} ${link}`);
    return json(200, { status: 'published', post: post.id, media: mediaId, permalink: link });
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
