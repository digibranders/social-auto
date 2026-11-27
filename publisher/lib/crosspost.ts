import { isPaused, NO_PAUSES, type PauseFile } from './pauses.js';
import { channelLabel, channelsFor, channelToken, hasEnded, postedKey, type Channel, type ChannelFile, type PostedLog } from './channels.js';
import { isWantedOn } from './schedule.js';
import type { CarouselImage, LinkedInPost, Visibility } from './linkedin.js';
import { dueWindowFor } from './schedule.js';
import { googleSummary, type GooglePost } from './google.js';

/** What the posting code needs from Facebook; the real one is lib/facebook.ts, tests use stubs. */
export interface FacebookApi {
  postPhotoFromUrl(pageId: string, token: string, imageUrl: string, caption: string): Promise<{ photoId: string; postId: string | null }>;
  postPhotos(pageId: string, token: string, imageUrls: readonly string[], caption: string): Promise<{ postId: string }>;
  postLink(postId: string, token: string): Promise<string | null>;
  pageHealth(pageId: string, token: string): Promise<{ ok: boolean; error?: string }>;
}

/** What the posting code needs from LinkedIn; the real one is lib/linkedin.ts, tests use stubs. */
export interface LinkedInApi {
  fetchImage(url: string): Promise<Uint8Array>;
  uploadImage(token: string, ownerUrn: string, image: Uint8Array): Promise<string>;
  postImage(token: string, authorUrn: string, assetUrn: string, caption: string, visibility: Visibility): Promise<LinkedInPost>;
  uploadImageUrn(token: string, ownerUrn: string, image: Uint8Array): Promise<string>;
  postMultiImage(token: string, authorUrn: string, images: readonly CarouselImage[], caption: string, visibility: Visibility): Promise<LinkedInPost>;
  /** Whether the saved token is still accepted. */
  memberHealth(token: string): Promise<{ ok: boolean; error?: string }>;
}

/** What the posting code needs from Google; the real one is lib/google.ts, tests use stubs. */
export interface GoogleApi {
  /** Publishes an update with one picture, using the saved refresh token. */
  postUpdate(refreshToken: string, place: { account: string; location: string }, update: { summary: string; imageUrl: string }): Promise<GooglePost>;
  /** Whether the saved refresh token still works. */
  locationHealth(refreshToken: string): Promise<{ ok: boolean; error?: string }>;
}

/** What the posting code needs from Instagram; the real one is lib/instagram.ts, tests use stubs. */
export interface InstagramApi {
  createImageContainer(userId: string, token: string, imageUrl: string, caption: string): Promise<string>;
  prepareCarousel(userId: string, token: string, imageUrls: readonly string[], caption: string): Promise<{ containerId: string }>;
  waitUntilReady(containerId: string, token: string): Promise<void>;
  publishContainer(userId: string, token: string, containerId: string): Promise<string>;
  permalink(mediaId: string, token: string): Promise<string>;
  /** Whether the saved token is still accepted. */
  tokenHealth(token: string): Promise<{ ok: boolean; error?: string }>;
}

export interface PostToSend {
  id: string;
  brand?: string;
  date: string;
  caption: string;
  /** Path under the deployment, e.g. /posts/x.jpg or /api/edited-image?k=... */
  image: string | null;
  /** A carousel: every picture in order, the first being `image`. Absent for a post with one picture. */
  images?: string[];
  /** Where this post is meant to go; missing means every connected channel. */
  channels?: string[];
}

export interface CrosspostResult {
  channel: string;
  account: string;
  status: 'posted' | 'already-posted' | 'skipped-before-connection' | 'dry-run-ready' | 'failed' | 'held' | 'duplicate';
  remoteId?: string;
  permalink?: string | null;
  error?: string;
}

/** A channel counts only posts from the moment it was connected: earlier days were never meant for it. */
function belongsTo(post: PostToSend, channel: Channel): boolean {
  return Date.parse(post.date) >= Date.parse(channel.connectedAt);
}

/**
 * The public addresses of every picture a post carries, the cover first. A post with a list of two or more is a carousel; otherwise it is the one `image`,
 * or nothing when the poster is gone.
 */
export function pictureUrls(post: { image: string | null; images?: string[] }, origin: string): string[] {
  const paths = post.images && post.images.length > 1 ? post.images : post.image ? [post.image] : [];
  return paths.map((path) => `${origin}${path}`);
}

/**
 * Sends one post to every Facebook Page connected for its client. One Page failing never stops the others;
 * a post already sent to a Page is never sent again. `record` is called after each success so a crash later
 * cannot lose the fact that it went out.
 */
export async function postToFacebook(options: {
  post: PostToSend;
  channels: ChannelFile;
  key: Buffer;
  origin: string;
  log: PostedLog;
  dryRun: boolean;
  api: FacebookApi;
  now: number;
  record: (key: string, entry: PostedLog[string]) => Promise<void>;
}): Promise<CrosspostResult[]> {
  const { post, key, api } = options;
  const results: CrosspostResult[] = [];
  for (const channel of targetChannels(options.channels, post, 'facebook')) {
    const base = { channel: channel.id, account: channelLabel(channel) };
    const logKey = postedKey(post.id, channel.id);
    try {
      if (!belongsTo(post, channel)) {
        results.push({ ...base, status: 'skipped-before-connection' });
        continue;
      }
      const already = options.log[logKey];
      if (already) {
        results.push({ ...base, status: 'already-posted', remoteId: already.remoteId, permalink: already.permalink });
        continue;
      }
      if (!post.image) throw new Error('the post has no picture to send');
      const token = channelToken(channel, key);
      if (options.dryRun) {
        const health = await api.pageHealth(channel.pageId, token);
        results.push(health.ok ? { ...base, status: 'dry-run-ready' } : { ...base, status: 'failed', error: health.error ?? 'page check failed' });
        continue;
      }
      const urls = pictureUrls(post, options.origin);
      const posted = urls.length > 1
        ? { photoId: '', postId: (await api.postPhotos(channel.pageId, token, urls, post.caption)).postId }
        : await api.postPhotoFromUrl(channel.pageId, token, urls[0] as string, post.caption);
      const remoteId = posted.postId ?? posted.photoId;
      const permalink = await api.postLink(remoteId, token).catch(() => null);
      await options.record(logKey, { remoteId, permalink, postedAt: new Date(options.now).toISOString() });
      results.push({ ...base, status: 'posted', remoteId, permalink });
    } catch (error) {
      results.push({ ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * Sends one post to every LinkedIn profile connected for its client. Same rules as Facebook: each profile is
 * independent, nothing is sent twice, and an expired connection fails with a message that says what to do.
 */
export async function postToLinkedIn(options: {
  post: PostToSend;
  channels: ChannelFile;
  key: Buffer;
  origin: string;
  log: PostedLog;
  dryRun: boolean;
  api: LinkedInApi;
  now: number;
  record: (key: string, entry: PostedLog[string]) => Promise<void>;
}): Promise<CrosspostResult[]> {
  const { post, key, api } = options;
  const results: CrosspostResult[] = [];
  for (const channel of targetChannels(options.channels, post, 'linkedin')) {
    const base = { channel: channel.id, account: channelLabel(channel) };
    const logKey = postedKey(post.id, channel.id);
    try {
      if (!belongsTo(post, channel)) {
        results.push({ ...base, status: 'skipped-before-connection' });
        continue;
      }
      const already = options.log[logKey];
      if (already) {
        results.push({ ...base, status: 'already-posted', remoteId: already.remoteId, permalink: already.permalink });
        continue;
      }
      if (!post.image) throw new Error('the post has no picture to send');
      if (hasEnded(channel, options.now)) {
        throw new Error(`The LinkedIn connection for ${channel.memberName} has expired. They need to open their connect link again and press Allow.`);
      }
      const token = channelToken(channel, key);
      if (options.dryRun) {
        const health = await api.memberHealth(token);
        results.push(health.ok ? { ...base, status: 'dry-run-ready' } : { ...base, status: 'failed', error: health.error ?? 'LinkedIn check failed' });
        continue;
      }
      const urls = pictureUrls(post, options.origin);
      let posted: LinkedInPost;
      if (urls.length > 1) {
        const references: CarouselImage[] = [];
        for (const [i, url] of urls.entries()) {
          const urn = await api.uploadImageUrn(token, channel.memberUrn, await api.fetchImage(url));
          references.push({ urn, altText: `Slide ${i + 1} of ${urls.length}` });
        }
        posted = await api.postMultiImage(token, channel.memberUrn, references, post.caption, 'PUBLIC');
      } else {
        const image = await api.fetchImage(urls[0] as string);
        const asset = await api.uploadImage(token, channel.memberUrn, image);
        posted = await api.postImage(token, channel.memberUrn, asset, post.caption, 'PUBLIC');
      }
      await options.record(logKey, { remoteId: posted.urn, permalink: posted.url, postedAt: new Date(options.now).toISOString() });
      results.push({ ...base, status: 'posted', remoteId: posted.urn, permalink: posted.url });
    } catch (error) {
      results.push({ ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * Sends one post to every Google business location connected for its client, as an update. Same rules as the
 * other channels: each location is independent, nothing is sent twice. Google fetches the picture itself from
 * the public address, so no picture is downloaded here.
 */
export async function postToGoogle(options: {
  post: PostToSend;
  channels: ChannelFile;
  key: Buffer;
  origin: string;
  log: PostedLog;
  dryRun: boolean;
  api: GoogleApi;
  now: number;
  record: (key: string, entry: PostedLog[string]) => Promise<void>;
}): Promise<CrosspostResult[]> {
  const { post, key, api } = options;
  const results: CrosspostResult[] = [];
  for (const channel of targetChannels(options.channels, post, 'google')) {
    const base = { channel: channel.id, account: channelLabel(channel) };
    const logKey = postedKey(post.id, channel.id);
    try {
      if (!belongsTo(post, channel)) {
        results.push({ ...base, status: 'skipped-before-connection' });
        continue;
      }
      const already = options.log[logKey];
      if (already) {
        results.push({ ...base, status: 'already-posted', remoteId: already.remoteId, permalink: already.permalink });
        continue;
      }
      if (!post.image) throw new Error('the post has no picture to send');
      const token = channelToken(channel, key);
      if (options.dryRun) {
        const health = await api.locationHealth(token);
        results.push(health.ok ? { ...base, status: 'dry-run-ready' } : { ...base, status: 'failed', error: health.error ?? 'Google check failed' });
        continue;
      }
      const posted = await api.postUpdate(token, channel, { summary: googleSummary(post.caption), imageUrl: `${options.origin}${post.image}` });
      await options.record(logKey, { remoteId: posted.name, permalink: posted.url, postedAt: new Date(options.now).toISOString() });
      results.push({ ...base, status: 'posted', remoteId: posted.name, permalink: posted.url });
    } catch (error) {
      results.push({ ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * Sends one post to every customer Instagram account connected for its client (the team's own account is handled
 * separately by the daily job). Same rules as the others: each account is independent, nothing is sent twice, and
 * an expired connection fails with a message that says what to do.
 */
export async function postToInstagram(options: {
  post: PostToSend;
  channels: ChannelFile;
  key: Buffer;
  origin: string;
  log: PostedLog;
  dryRun: boolean;
  api: InstagramApi;
  now: number;
  record: (key: string, entry: PostedLog[string]) => Promise<void>;
}): Promise<CrosspostResult[]> {
  const { post, key, api } = options;
  const results: CrosspostResult[] = [];
  for (const channel of targetChannels(options.channels, post, 'instagram')) {
    const base = { channel: channel.id, account: channelLabel(channel) };
    const logKey = postedKey(post.id, channel.id);
    try {
      if (!belongsTo(post, channel)) {
        results.push({ ...base, status: 'skipped-before-connection' });
        continue;
      }
      const already = options.log[logKey];
      if (already) {
        results.push({ ...base, status: 'already-posted', remoteId: already.remoteId, permalink: already.permalink });
        continue;
      }
      if (!post.image) throw new Error('the post has no picture to send');
      if (hasEnded(channel, options.now)) {
        throw new Error(`The Instagram connection for ${channel.username} has expired. They need to open their connect link again and press Allow.`);
      }
      const token = channelToken(channel, key);
      if (options.dryRun) {
        const health = await api.tokenHealth(token);
        results.push(health.ok ? { ...base, status: 'dry-run-ready' } : { ...base, status: 'failed', error: health.error ?? 'Instagram check failed' });
        continue;
      }
      const urls = pictureUrls(post, options.origin);
      let container: string;
      if (urls.length > 1) {
        container = (await api.prepareCarousel(channel.userId, token, urls, post.caption)).containerId;
      } else {
        container = await api.createImageContainer(channel.userId, token, urls[0] as string, post.caption);
        await api.waitUntilReady(container, token);
      }
      const mediaId = await api.publishContainer(channel.userId, token, container);
      const link = await api.permalink(mediaId, token).catch(() => '');
      await options.record(logKey, { remoteId: mediaId, permalink: link || null, postedAt: new Date(options.now).toISOString() });
      results.push({ ...base, status: 'posted', remoteId: mediaId, permalink: link || null });
    } catch (error) {
      results.push({ ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/**
 * The channels of a post's client that it is meant for on one platform. A post from a posting plan that names the platform alone (not an account) is sent
 * only when the client has exactly one account there: with two or more it is held, because the choice cannot be guessed and a wrong post is public.
 */
export function targetChannels<P extends Channel['platform']>(channels: ChannelFile, post: { brand?: string; channels?: string[]; fromPlan?: boolean }, platform: P): Array<Extract<Channel, { platform: P }>> {
  const wanted = channelsFor(channels, post.brand ?? 'default', platform).filter((c) => isWantedOn(post, c.id, platform));
  if (post.fromPlan === true && wanted.length > 1 && post.channels?.includes(platform)) return [];
  return wanted;
}

export interface CrosspostStatus {
  /** The channel's id, as a product names it when choosing where a post goes. */
  id: string;
  platform: Channel['platform'];
  account: string;
  state: 'published' | 'scheduled' | 'due' | 'missed' | 'skipped' | 'paused';
  permalink: string | null;
}

/** Where a post stands on every connected channel of its client, for the dashboard. */
export function crosspostStatusFor(
  post: { id: string; brand?: string; date: string; channels?: string[]; skipped?: boolean; manual?: boolean; ownTime?: boolean },
  channels: ChannelFile,
  log: PostedLog,
  now: number,
  pauses: PauseFile = NO_PAUSES,
): CrosspostStatus[] {
  const at = Date.parse(post.date);
  return channelsFor(channels, post.brand ?? 'default')
    .filter((channel) => isWantedOn(post, channel.id, channel.platform))
    .filter((channel) => at >= Date.parse(channel.connectedAt))
    .map((channel): CrosspostStatus => {
      const done = log[postedKey(post.id, channel.id)];
      const held = !done && isPaused(pauses, post.brand ?? 'default', channel.id, { nowMs: now, postMs: at });
      let state: CrosspostStatus['state'];
      if (done?.skipped) state = 'skipped';
      else if (done) state = 'published';
      else if (post.skipped) state = 'skipped';
      else if (held && (at > now || now - at < dueWindowFor(post))) state = 'paused';
      else if (at > now) state = 'scheduled';
      else if (now - at < dueWindowFor(post)) state = 'due';
      else state = 'missed';
      return { id: channel.id, platform: channel.platform, account: channelLabel(channel), state, permalink: done?.skipped ? null : (done?.permalink ?? null) };
    });
}
