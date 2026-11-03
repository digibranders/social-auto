/**
 * Sends one post to every channel it is wanted on, and tells the product and the team about the outcome. Shared by the daily
 * cron and by a product's "send now". Each channel is independent: one failing never stops another.
 */
import { parseKey } from './crypto.js';
import { postToFacebook, postToGoogle, postToInstagram, postToLinkedIn, type CrosspostResult, type FacebookApi, type GoogleApi, type InstagramApi, type LinkedInApi } from './crosspost.js';
import { pageHealth, postLink, postPhotoFromUrl } from './facebook.js';
import { describeError, requireEnv } from './http.js';
import { createImageContainer, permalink, publishContainer, recentMedia, tokenHealth, waitUntilReady } from './instagram.js';
import { accessTokenFor, createPost, locationHealth } from './google.js';
import { parseProducts } from './products.js';
import { dispatch, eventsForResults } from './webhooks.js';
import { fetchImage, memberHealth, postImage, uploadImage } from './linkedin.js';
import { notify } from './notify.js';
import type { PostedEntry } from './channels.js';
import { isWantedOn, sameCaption, type ScheduledPost } from './schedule.js';
import { loadChannels, loadClients, loadPosted, savePosted } from './store.js';

const facebookApi: FacebookApi = { postPhotoFromUrl, postLink, pageHealth };
const linkedInApi: LinkedInApi = { fetchImage, uploadImage, postImage, memberHealth };
const instagramApi: InstagramApi = { createImageContainer, waitUntilReady, publishContainer, permalink, tokenHealth };
const googleApp = (): { clientId: string; clientSecret: string } => ({ clientId: requireEnv('GOOGLE_CLIENT_ID'), clientSecret: requireEnv('GOOGLE_CLIENT_SECRET') });
const googleApi: GoogleApi = {
  postUpdate: async (refreshToken, place, update) => createPost(await accessTokenFor(googleApp(), refreshToken), place.account, place.location, update),
  locationHealth: (refreshToken) => locationHealth(googleApp(), refreshToken),
};

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

type Platform = 'facebook' | 'linkedin' | 'instagram' | 'google';

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
    if (platform === 'facebook') return await postToFacebook({ ...common, api: facebookApi });
    if (platform === 'linkedin') return await postToLinkedIn({ ...common, api: linkedInApi });
    if (platform === 'google') return await postToGoogle({ ...common, api: googleApi });
    return await postToInstagram({ ...common, api: instagramApi });
  } catch (error) {
    return [{ channel: platform, account: platform, status: 'failed', error: describeError(error) }];
  }
}

/** Tells the products whose customers' posts just went out (or failed). Never throws: a product that is down must not stop posting. */
async function tellProducts(post: ScheduledPost, results: readonly CrosspostResult[]): Promise<void> {
  try {
    const products = parseProducts(process.env['PRODUCTS']);
    if (products.length === 0) return;
    const { file } = await loadClients();
    await dispatch(eventsForResults(post.brand ?? 'default', post.id, results, file, Date.now()), products);
  } catch (error) {
    console.error(describeError(error));
  }
}

export interface SendOutcome {
  instagram: Record<string, unknown>;
  facebook: CrosspostResult[];
  linkedin: CrosspostResult[];
  google: CrosspostResult[];
  accounts: CrosspostResult[];
  failed: boolean;
}

/** Sends the post everywhere it is wanted. Without `dryRun` it also tells the product and alerts the team about failures. */
export async function sendPost(post: ScheduledPost, origin: string, dryRun: boolean): Promise<SendOutcome> {
  const instagram: Record<string, unknown> = isWantedOn(post, 'instagram')
    ? await sendToInstagram(post, origin, dryRun).catch((error: unknown) => ({ status: 'failed', error: describeError(error) }))
    : { status: 'not-selected', post: post.id };
  const facebook = await sendToChannels('facebook', post, origin, dryRun);
  const linkedin = await sendToChannels('linkedin', post, origin, dryRun);
  const google = await sendToChannels('google', post, origin, dryRun);
  const accounts = await sendToChannels('instagram', post, origin, dryRun);

  if (!dryRun) {
    await tellProducts(post, [...facebook, ...linkedin, ...google, ...accounts]);
    if (instagram['status'] === 'failed') {
      await notify({
        title: 'Instagram post failed',
        message: `${post.id}: ${String(instagram['error'])}\n\nA post stays due for 20 hours. Fix the cause, then ask Claude to re-send it.`,
        priority: 'high',
        tags: 'rotating_light',
      });
    }
    for (const [name, list] of [['Facebook', facebook], ['LinkedIn', linkedin], ['Google', google], ['Instagram', accounts]] as const) {
      for (const result of list.filter((r) => r.status === 'failed')) {
        await notify({
          title: `${name} post failed`,
          message: `${result.account}: ${result.error ?? 'unknown error'}\n\nThe other channels are not affected. Fix the cause, then ask Claude to re-send it.`,
          priority: 'high',
          tags: 'rotating_light',
        });
      }
    }
  }
  const failed = instagram['status'] === 'failed' || [...facebook, ...linkedin, ...google, ...accounts].some((r) => r.status === 'failed');
  return { instagram, facebook, linkedin, google, accounts, failed };
}
