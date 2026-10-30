/**
 * Daily Vercel Cron: publishes the post that is due today to Instagram and to every connected Facebook Page of
 * its client, and sends a push alert when posting fails or a client's schedule is about to run out.
 * Each channel is independent: one failing never stops another.
 *
 * GET /api/cron            (called by Vercel Cron with Authorization: Bearer $CRON_SECRET)
 * GET /api/cron?dryRun=1   prepares everything without publishing (no alerts)
 * GET /api/cron?dryRun=1&post=<id>   same, for a named post regardless of its date
 */
import { schedule as scheduleData } from '../data/schedule.js';
import { parseKey } from '../lib/crypto.js';
import { postToFacebook, type CrosspostResult, type FacebookApi } from '../lib/crosspost.js';
import { pageHealth, postLink, postPhotoFromUrl } from '../lib/facebook.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import {
  createImageContainer,
  permalink,
  publishContainer,
  recentMedia,
  waitUntilReady,
} from '../lib/instagram.js';
import { notify } from '../lib/notify.js';
import { applyOverrides } from '../lib/overrides.js';
import { duePost, lowQueueWarnings, parseSchedule, sameCaption, type ScheduledPost } from '../lib/schedule.js';
import { loadChannels, loadOverrides, loadPosted, savePosted } from '../lib/store.js';

const facebookApi: FacebookApi = { postPhotoFromUrl, postLink, pageHealth };

async function sendToInstagram(post: ScheduledPost, origin: string, dryRun: boolean): Promise<Record<string, unknown>> {
  const token = requireEnv('INSTAGRAM_TOKEN');
  const userId = requireEnv('INSTAGRAM_USER_ID');
  if (!post.image) throw new Error(`${post.id} has no picture to send`);

  const alreadyLive = (await recentMedia(userId, token)).find((m) => sameCaption(m.caption, post.caption));
  if (alreadyLive) return { status: 'already-published', post: post.id, media: alreadyLive.id };

  const containerId = await createImageContainer(userId, token, `${origin}${post.image}`, post.caption);
  await waitUntilReady(containerId, token);
  if (dryRun) return { status: 'dry-run-ready', post: post.id, container: containerId };

  const mediaId = await publishContainer(userId, token, containerId);
  const link = await permalink(mediaId, token).catch(() => '');
  console.log(`published ${post.id} as ${mediaId} ${link}`);
  return { status: 'published', post: post.id, media: mediaId, permalink: link };
}

/** Never throws: a problem here must not hide what happened on Instagram. */
async function sendToFacebook(post: ScheduledPost, origin: string, dryRun: boolean): Promise<CrosspostResult[]> {
  try {
    const { file } = await loadChannels();
    if (file.channels.length === 0) return [];
    const key = parseKey(process.env['CHANNEL_KEY']);
    const { log } = await loadPosted();
    return await postToFacebook({
      post,
      channels: file,
      key,
      origin,
      log,
      dryRun,
      api: facebookApi,
      now: Date.now(),
      // Reload before each write so a second Page's record never overwrites the first's.
      record: async (logKey, entry) => {
        const latest = await loadPosted();
        await savePosted({ ...latest.log, [logKey]: entry }, latest.etag);
      },
    });
  } catch (error) {
    return [{ channel: 'facebook', account: 'facebook', status: 'failed', error: describeError(error) }];
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
    const schedule = applyOverrides(parseSchedule(scheduleData), overrides);

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

    const instagram = await sendToInstagram(post, origin, dryRun).catch((error: unknown) => ({
      status: 'failed',
      error: describeError(error),
    }));
    const facebook = await sendToFacebook(post, origin, dryRun);

    if (!dryRun) {
      if (instagram['status'] === 'failed') {
        await notify({
          title: 'Instagram post failed',
          message: `${String(instagram['error'])}\n\nA post stays due for 20 hours. Fix the cause, then ask Claude to re-send it.`,
          priority: 'high',
          tags: 'rotating_light',
        });
      }
      for (const result of facebook.filter((r) => r.status === 'failed')) {
        await notify({
          title: 'Facebook post failed',
          message: `${result.account}: ${result.error ?? 'unknown error'}\n\nInstagram is not affected. Fix the cause, then ask Claude to re-send it.`,
          priority: 'high',
          tags: 'rotating_light',
        });
      }
    }

    const failed = instagram['status'] === 'failed' || facebook.some((r) => r.status === 'failed');
    return json(failed ? 500 : 200, { ...instagram, facebook });
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
