/**
 * Daily Vercel Cron: publishes the post that is due today to Instagram and to every connected Facebook Page and LinkedIn profile
 * of its client, and sends a push alert when posting fails or a client's schedule is about to run out.
 * Each channel is independent: one failing never stops another.
 *
 * GET /api/cron            (called by Vercel Cron with Authorization: Bearer $CRON_SECRET)
 * GET /api/cron?dryRun=1   prepares everything without publishing (no alerts)
 * GET /api/cron?dryRun=1&post=<id>   same, for a named post regardless of its date
 */
import { schedule as scheduleData } from '../data/schedule.js';
import { parseKey } from '../lib/crypto.js';
import { expiringSoon } from '../lib/channels.js';
import { postToFacebook, postToLinkedIn, type CrosspostResult, type FacebookApi, type LinkedInApi } from '../lib/crosspost.js';
import { pageHealth, postLink, postPhotoFromUrl } from '../lib/facebook.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import {
  createImageContainer,
  permalink,
  publishContainer,
  recentMedia,
  waitUntilReady,
} from '../lib/instagram.js';
import { fetchImage, memberHealth, postImage, uploadImage } from '../lib/linkedin.js';
import { notify } from '../lib/notify.js';
import { applyOverrides } from '../lib/overrides.js';
import type { PostedEntry } from '../lib/channels.js';
import { duePost, lowQueueWarnings, parseSchedule, sameCaption, type ScheduledPost } from '../lib/schedule.js';
import { loadChannels, loadOverrides, loadPosted, savePosted } from '../lib/store.js';

const facebookApi: FacebookApi = { postPhotoFromUrl, postLink, pageHealth };
const linkedInApi: LinkedInApi = { fetchImage, uploadImage, postImage, memberHealth };

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

type Platform = 'facebook' | 'linkedin';

/** Never throws: a problem here must not hide what happened on Instagram or another channel. */
async function sendToChannels(platform: Platform, post: ScheduledPost, origin: string, dryRun: boolean): Promise<CrosspostResult[]> {
  try {
    const { file } = await loadChannels();
    if (!file.channels.some((c) => c.platform === platform)) return [];
    const key = parseKey(process.env['CHANNEL_KEY']);
    const { log } = await loadPosted();
    const common = {
      post,
      channels: file,
      key,
      origin,
      log,
      dryRun,
      now: Date.now(),
      // Reload before each write so a second channel's record never overwrites the first's.
      record: async (logKey: string, entry: PostedEntry): Promise<void> => {
        const latest = await loadPosted();
        await savePosted({ ...latest.log, [logKey]: entry }, latest.etag);
      },
    };
    return platform === 'facebook'
      ? await postToFacebook({ ...common, api: facebookApi })
      : await postToLinkedIn({ ...common, api: linkedInApi });
  } catch (error) {
    return [{ channel: platform, account: platform, status: 'failed', error: describeError(error) }];
  }
}

/** LinkedIn gives no refresh, so tell the team before a connection ends (once a day, on 7, 3, 1 and 0 days left). */
async function warnAboutExpiringLinkedIn(): Promise<void> {
  try {
    const { file } = await loadChannels();
    for (const { channel, days } of expiringSoon(file, Date.now())) {
      await notify({
        title: days === 0 ? 'LinkedIn connection ends today' : `LinkedIn connection ends in ${days} day${days === 1 ? '' : 's'}`,
        message:
          `${channel.memberName} (${channel.brand}). Send them a new connect link from the dashboard ` +
          '(Clients, the client, Channels, LinkedIn) and ask them to press Allow again. Posting to LinkedIn stops when it ends.',
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
      await warnAboutExpiringLinkedIn();
    }

    // A specific post can be named only in dry-run mode, to test the pipeline before its day.
    const testPostId = dryRun ? url.searchParams.get('post') : null;
    const post = testPostId ? (schedule.find((p) => p.id === testPostId) ?? null) : duePost(schedule, Date.now());
    if (!post) return json(200, { status: testPostId ? 'post-not-found' : 'nothing-due' });

    const instagram = await sendToInstagram(post, origin, dryRun).catch((error: unknown) => ({
      status: 'failed',
      error: describeError(error),
    }));
    const facebook = await sendToChannels('facebook', post, origin, dryRun);
    const linkedin = await sendToChannels('linkedin', post, origin, dryRun);

    if (!dryRun) {
      if (instagram['status'] === 'failed') {
        await notify({
          title: 'Instagram post failed',
          message: `${String(instagram['error'])}\n\nA post stays due for 20 hours. Fix the cause, then ask Claude to re-send it.`,
          priority: 'high',
          tags: 'rotating_light',
        });
      }
      for (const [name, results] of [['Facebook', facebook], ['LinkedIn', linkedin]] as const) {
        for (const result of results.filter((r) => r.status === 'failed')) {
          await notify({
            title: `${name} post failed`,
            message: `${result.account}: ${result.error ?? 'unknown error'}\n\nThe other channels are not affected. Fix the cause, then ask Claude to re-send it.`,
            priority: 'high',
            tags: 'rotating_light',
          });
        }
      }
    }

    const failed = instagram['status'] === 'failed' || [...facebook, ...linkedin].some((r) => r.status === 'failed');
    return json(failed ? 500 : 200, { ...instagram, facebook, linkedin });
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
