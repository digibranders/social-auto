import { isPaused, NO_PAUSES, type PauseFile } from './pauses.js';
import { channelLabel, channelsFor, channelToken, postedKey, type Channel, type ChannelFile, type PostedLog } from './channels.js';
import { isWantedOn } from './schedule.js';
import type { LinkedInPost, Visibility } from './linkedin.js';
import { dueWindowFor } from './schedule.js';
import { googleSummary, type GooglePost } from './google.js';

/** What the posting code needs from Facebook; the real one is lib/facebook.ts, tests use stubs. */
export interface FacebookApi {
  postPhotoFromUrl(pageId: string, token: string, imageUrl: string, caption: string): Promise<{ photoId: string; postId: string | null }>;
  postLink(postId: string, token: string): Promise<string | null>;
  pageHealth(pageId: string, token: string): Promise<{ ok: boolean; error?: string }>;
}

/** What the posting code needs from LinkedIn; the real one is lib/linkedin.ts, tests use stubs. */
export interface LinkedInApi {
  fetchImage(url: string): Promise<Uint8Array>;
  uploadImage(token: string, ownerUrn: string, image: Uint8Array): Promise<string>;
  postImage(token: string, authorUrn: string, assetUrn: string, caption: string, visibility: Visibility): Promise<LinkedInPost>;
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
  /** Where this post is meant to go; missing means every connected channel. */
  channels?: string[];
}

export interface CrosspostResult {
  channel: string;
  account: string;
  status: 'posted' | 'already-posted' | 'skipped-before-connection' | 'dry-run-ready' | 'failed' | 'held';
  remoteId?: string;
  permalink?: string | null;
  error?: string;
}

/** A channel counts only posts from the moment it was connected: earlier days were never meant for it. */
function belongsTo(post: PostToSend, channel: Channel): boolean {
  return Date.parse(post.date) >= Date.parse(channel.connectedAt);
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
  for (const channel of channelsFor(options.channels, post.brand ?? 'default', 'facebook').filter((c) => isWantedOn(post, c.id, 'facebook'))) {
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
      const posted = await api.postPhotoFromUrl(channel.pageId, token, `${options.origin}${post.image}`, post.caption);
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
  for (const channel of channelsFor(options.channels, post.brand ?? 'default', 'linkedin').filter((c) => isWantedOn(post, c.id, 'linkedin'))) {
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
      if (Date.parse(channel.expiresAt) <= options.now) {
        throw new Error(`The LinkedIn connection for ${channel.memberName} has expired. They need to open their connect link again and press Allow.`);
      }
      const token = channelToken(channel, key);
      if (options.dryRun) {
        const health = await api.memberHealth(token);
        results.push(health.ok ? { ...base, status: 'dry-run-ready' } : { ...base, status: 'failed', error: health.error ?? 'LinkedIn check failed' });
        continue;
      }
      const image = await api.fetchImage(`${options.origin}${post.image}`);
      const asset = await api.uploadImage(token, channel.memberUrn, image);
      const posted = await api.postImage(token, channel.memberUrn, asset, post.caption, 'PUBLIC');
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
  for (const channel of channelsFor(options.channels, post.brand ?? 'default', 'google').filter((c) => isWantedOn(post, c.id, 'google'))) {
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
  for (const channel of channelsFor(options.channels, post.brand ?? 'default', 'instagram').filter((c) => isWantedOn(post, c.id, 'instagram'))) {
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
      if (Date.parse(channel.expiresAt) <= options.now) {
        throw new Error(`The Instagram connection for ${channel.username} has expired. They need to open their connect link again and press Allow.`);
      }
      const token = channelToken(channel, key);
      if (options.dryRun) {
        const health = await api.tokenHealth(token);
        results.push(health.ok ? { ...base, status: 'dry-run-ready' } : { ...base, status: 'failed', error: health.error ?? 'Instagram check failed' });
        continue;
      }
      const container = await api.createImageContainer(channel.userId, token, `${options.origin}${post.image}`, post.caption);
      await api.waitUntilReady(container, token);
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
      const held = !done && isPaused(pauses, post.brand ?? 'default', channel.id);
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
