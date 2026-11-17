/**
 * Sends one post to every channel it is wanted on, and tells the product and the team about the outcome. Shared by the daily
 * cron and by a product's "send now". Each channel is independent: one failing never stops another.
 */
import { parseKey } from './crypto.js';
import { pictureUrls, postToFacebook, postToGoogle, postToInstagram, postToLinkedIn, type CrosspostResult, type FacebookApi, type GoogleApi, type InstagramApi, type LinkedInApi } from './crosspost.js';
import { pageHealth, postLink, postPhotoFromUrl, postPhotos } from './facebook.js';
import { describeError, requireEnv } from './http.js';
import { createImageContainer, permalink, prepareCarousel, publishContainer, recentMedia, tokenHealth, waitUntilReady } from './instagram.js';
import { accessTokenFor, createPost, locationHealth } from './google.js';
import { parseProducts } from './products.js';
import { publishEvents } from './events.js';
import { eventsForResults } from './webhooks.js';
import { fetchImage, memberHealth, postImage, postMultiImage, uploadImage, uploadImageUrn } from './linkedin.js';
import { notify } from './notify.js';
import { channelLabel, postedKey, type PostedEntry } from './channels.js';
import { isPaused, NO_PAUSES, type PauseFile } from './pauses.js';
import { isWantedOn, sameCaption, usesTeamInstagram, type ScheduledPost } from './schedule.js';
import { forPlatform } from './variants.js';
import { fingerprintOf } from './duplicates.js';
import { duplicateText, guardChannels } from './send-guards.js';
import { loadChannels, loadClients, loadPauses, loadPosted, savePosted } from './store.js';

const facebookApi: FacebookApi = { postPhotoFromUrl, postPhotos, postLink, pageHealth };
const linkedInApi: LinkedInApi = { fetchImage, uploadImage, postImage, uploadImageUrn, postMultiImage, memberHealth };
const instagramApi: InstagramApi = { createImageContainer, waitUntilReady, prepareCarousel, publishContainer, permalink, tokenHealth };
const googleApp = (): { clientId: string; clientSecret: string } => ({ clientId: requireEnv('GOOGLE_CLIENT_ID'), clientSecret: requireEnv('GOOGLE_CLIENT_SECRET') });
const googleApi: GoogleApi = {
  postUpdate: async (refreshToken, place, update) => createPost(await accessTokenFor(googleApp(), refreshToken), place.account, place.location, update),
  locationHealth: (refreshToken) => locationHealth(googleApp(), refreshToken),
};

async function sendToInstagram(mainPost: ScheduledPost, origin: string, dryRun: boolean): Promise<Record<string, unknown>> {
  const post = forPlatform(mainPost, 'instagram');
  const token = requireEnv('INSTAGRAM_TOKEN');
  const userId = requireEnv('INSTAGRAM_USER_ID');
  if (!post.image) throw new Error(`${post.id} has no picture to send`);

  const alreadyLive = (await recentMedia(userId, token)).find((m) => sameCaption(m.caption, post.caption));
  if (alreadyLive) return { status: 'already-published', post: post.id, media: alreadyLive.id };

  const urls = pictureUrls(post, origin);
  let containerId: string;
  if (urls.length > 1) {
    containerId = (await prepareCarousel(userId, token, urls, post.caption)).containerId;
  } else {
    containerId = await createImageContainer(userId, token, urls[0] as string, post.caption);
    await waitUntilReady(containerId, token);
  }
  if (dryRun) return { status: 'dry-run-ready', post: post.id, container: containerId };

  const mediaId = await publishContainer(userId, token, containerId);
  const link = await permalink(mediaId, token).catch(() => '');
  console.log(`published ${post.id} as ${mediaId} ${link}`);
  return { status: 'published', post: post.id, media: mediaId, permalink: link };
}

type Platform = 'facebook' | 'linkedin' | 'instagram' | 'google';

/** What is written, for a post held back by a pause, so that it is never sent late once the pause ends. */
const heldEntry = (now: number): PostedEntry => ({ remoteId: 'held', permalink: null, postedAt: new Date(now).toISOString(), skipped: true });

/** Writes these entries (unless the log already has one for the key). Reloads first, so another write is never lost. */
async function recordEntries(wanted: Record<string, PostedEntry>): Promise<void> {
  if (Object.keys(wanted).length === 0) return;
  const latest = await loadPosted();
  const entries = Object.fromEntries(Object.entries(wanted).filter(([logKey]) => !latest.log[logKey]));
  if (Object.keys(entries).length > 0) await savePosted({ ...latest.log, ...entries }, latest.etag);
}

/** Marks posts as held for these channel ids ("instagram" for the team's own account). */
async function recordHeld(postId: string, channelIds: readonly string[], now: number): Promise<void> {
  await recordEntries(Object.fromEntries(channelIds.map((id) => [postedKey(postId, id), heldEntry(now)])));
}

/** Never throws: a problem here must not hide what happened on Instagram or another channel. */
async function sendToChannels(platform: Platform, mainPost: ScheduledPost, origin: string, dryRun: boolean, pauses: PauseFile): Promise<CrosspostResult[]> {
  // Each platform gets its own caption and picture when the post has them.
  const post = forPlatform(mainPost, platform);
  try {
    const { file } = await loadChannels();
    // Nothing connected on this platform is only a reason to stop when the post does not name an exact account here: a post that names one needs the check below.
    const namesAccountHere = (post.channels ?? []).some((id) => id.startsWith(`${platform}:`));
    if (!file.channels.some((c) => c.platform === platform) && !namesAccountHere) return [];
    const key = parseKey(process.env['CHANNEL_KEY']);
    const { log } = await loadPosted();
    const now = Date.now();
    const brand = post.brand ?? 'default';
    // A channel that is paused, or was held when the post first came due, is left out; the post still goes to the others.
    const held = file.channels.filter(
      (c) => c.platform === platform && c.brand === brand && isWantedOn(post, c.id) && (isPaused(pauses, brand, c.id, { nowMs: now, postMs: Date.parse(post.date) }) || log[postedKey(post.id, c.id)]?.skipped === true),
    );
    const heldIds = new Set(held.map((c) => c.id));
    if (!dryRun) await recordHeld(post.id, held.filter((c) => Date.parse(post.date) >= Date.parse(c.connectedAt)).map((c) => c.id), now);
    // Two checks before anything is sent: a channel that already received these words under another post id is left out, and so is an exact account the
    // post names that is no longer connected (it is never sent to a different account in its place).
    const fingerprint = fingerprintOf(post.caption);
    const guards = guardChannels({ channels: file.channels.filter((c) => !heldIds.has(c.id)) }, post, platform, log, now);
    const duplicateIds = new Set(guards.duplicates.map((d) => d.channel.id));
    if (!dryRun) {
      await recordEntries(Object.fromEntries(guards.duplicates.map(({ channel, of }) => [postedKey(post.id, channel.id), { remoteId: 'duplicate', permalink: of.entry.permalink, postedAt: new Date(now).toISOString(), skipped: true as const, fingerprint, duplicateOf: of.key }])));
      if (guards.gone.length > 0) {
        await notify({
          title: 'Post held: its account is no longer connected',
          message: `${post.brand ?? 'default'}: the post ${post.id} is meant for ${guards.gone.join(', ')}, which is not connected any more. It was not sent anywhere else and will not be sent later. Connect the account again for the posts after it, or choose another account for the plan.`,
          priority: 'high',
        });
        await recordEntries(Object.fromEntries(guards.gone.map((id) => [postedKey(post.id, id), { remoteId: 'account-disconnected', permalink: null, postedAt: new Date(now).toISOString(), skipped: true as const, reason: 'ACCOUNT_DISCONNECTED' }])));
      }
    }
    const common = {
      post,
      channels: { channels: file.channels.filter((c) => !heldIds.has(c.id) && !duplicateIds.has(c.id)) },
      key,
      origin,
      log,
      dryRun,
      now,
      // Reload before each write so a second channel's record never overwrites the first's. What was sent is remembered by its words (see duplicates.ts).
      record: async (logKey: string, entry: PostedEntry): Promise<void> => {
        const latest = await loadPosted();
        await savePosted({ ...latest.log, [logKey]: { ...entry, fingerprint } }, latest.etag);
      },
    };
    const heldResults = [
      ...held.map((c): CrosspostResult => ({ channel: c.id, account: channelLabel(c), status: 'held' })),
      ...guards.duplicates.map(({ channel, of }): CrosspostResult => ({ channel: channel.id, account: channelLabel(channel), status: 'duplicate', permalink: of.entry.permalink, error: duplicateText(channel, of) })),
      ...guards.gone.map((id): CrosspostResult => ({ channel: id, account: id, status: 'held', error: `ACCOUNT_DISCONNECTED: ${id} is not connected any more, so the post was not sent anywhere in its place` })),
    ];
    if (platform === 'facebook') return [...heldResults, ...(await postToFacebook({ ...common, api: facebookApi }))];
    if (platform === 'linkedin') return [...heldResults, ...(await postToLinkedIn({ ...common, api: linkedInApi }))];
    if (platform === 'google') return [...heldResults, ...(await postToGoogle({ ...common, api: googleApi }))];
    return [...heldResults, ...(await postToInstagram({ ...common, api: instagramApi }))];
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
    await publishEvents(eventsForResults(post.brand ?? 'default', post.id, results, file, Date.now()), products);
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
export async function sendPost(post: ScheduledPost, origin: string, dryRun: boolean, given?: PauseFile): Promise<SendOutcome> {
  // The safety net: a caller that does not hand over the pauses still gets them from the store, so a post can never skip a pause or the end of a paid period by being sent another way.
  const pauses = given ?? (await loadPauses()).file;
  const brand = post.brand ?? 'default';
  const wantsInstagram = usesTeamInstagram(post);
  // The team's own Instagram account is the channel "instagram"; like the others it is held when paused, and stays held for this post.
  const heldBefore = wantsInstagram && !dryRun ? (await loadPosted().catch(() => ({ log: {} as Record<string, PostedEntry> }))).log[postedKey(post.id, 'instagram')]?.skipped === true : false;
  const instagramHeld = wantsInstagram && (isPaused(pauses, brand, 'instagram', { nowMs: Date.now(), postMs: Date.parse(post.date) }) || heldBefore);
  if (instagramHeld && !dryRun) await recordHeld(post.id, ['instagram'], Date.now()).catch((error: unknown) => console.error(describeError(error)));
  const instagram: Record<string, unknown> = instagramHeld
    ? { status: 'held', post: post.id }
    : wantsInstagram
      ? await sendToInstagram(post, origin, dryRun).catch((error: unknown) => ({ status: 'failed', error: describeError(error) }))
      : { status: 'not-selected', post: post.id };
  const facebook = await sendToChannels('facebook', post, origin, dryRun, pauses);
  const linkedin = await sendToChannels('linkedin', post, origin, dryRun, pauses);
  const google = await sendToChannels('google', post, origin, dryRun, pauses);
  const accounts = await sendToChannels('instagram', post, origin, dryRun, pauses);

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
