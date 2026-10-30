import { channelsFor, channelToken, postedKey, type Channel, type ChannelFile, type PostedLog } from './channels.js';
import { DUE_WINDOW_MS } from './schedule.js';

/** What the posting code needs from Facebook; the real one is lib/facebook.ts, tests use stubs. */
export interface FacebookApi {
  postPhotoFromUrl(pageId: string, token: string, imageUrl: string, caption: string): Promise<{ photoId: string; postId: string | null }>;
  postLink(postId: string, token: string): Promise<string | null>;
  pageHealth(pageId: string, token: string): Promise<{ ok: boolean; error?: string }>;
}

export interface PostToSend {
  id: string;
  brand?: string;
  date: string;
  caption: string;
  /** Path under the deployment, e.g. /posts/x.jpg or /api/edited-image?k=... */
  image: string | null;
}

export interface CrosspostResult {
  channel: string;
  account: string;
  status: 'posted' | 'already-posted' | 'skipped-before-connection' | 'dry-run-ready' | 'failed';
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
  for (const channel of channelsFor(options.channels, post.brand ?? 'default')) {
    const base = { channel: channel.id, account: channel.pageName };
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

export interface CrosspostStatus {
  platform: 'facebook';
  account: string;
  state: 'published' | 'scheduled' | 'due' | 'missed';
  permalink: string | null;
}

/** Where a post stands on every Facebook Page of its client, for the dashboard. */
export function facebookStatusFor(post: { id: string; brand?: string; date: string }, channels: ChannelFile, log: PostedLog, now: number): CrosspostStatus[] {
  const at = Date.parse(post.date);
  return channelsFor(channels, post.brand ?? 'default')
    .filter((channel) => at >= Date.parse(channel.connectedAt))
    .map((channel): CrosspostStatus => {
      const done = log[postedKey(post.id, channel.id)];
      let state: CrosspostStatus['state'];
      if (done) state = 'published';
      else if (at > now) state = 'scheduled';
      else if (now - at < DUE_WINDOW_MS) state = 'due';
      else state = 'missed';
      return { platform: 'facebook', account: channel.pageName, state, permalink: done?.permalink ?? null };
    });
}
