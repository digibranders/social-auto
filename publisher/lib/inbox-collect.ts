/**
 * The regular check of comments: reads the comments on every recent post of every connected Instagram and Facebook account and adds the new ones to the inbox.
 * It only reads. A post or account that fails is reported and skipped; the others carry on.
 */
import { channelToken, type Channel, type PostedLog } from './channels.js';
import { dayOf } from './analytics.js';
import { addComments, markChannel, tidy, type InboxFile } from './inbox.js';
import type { CommentsReading } from './inbox-fetch.js';

export interface InboxReaders {
  instagramComments(mediaId: string, token: string): Promise<CommentsReading>;
  facebookComments(postId: string, pageId: string, token: string): Promise<CommentsReading>;
}

/** Posts newer than this are read at every check; up to WATCH_DAYS they are read once a day; older ones are not read. */
export const FRESH_DAYS = 14;
export const WATCH_DAYS = 30;
const DAY_MS = 86_400_000;

export interface InboxCollectReport {
  posts: number;
  comments: number;
  reconnect: string[];
  failures: Array<{ id: string; reason: string }>;
}

export interface InboxCollectInput {
  file: InboxFile;
  channels: readonly Channel[];
  posted: PostedLog;
  key: Buffer;
  readers: InboxReaders;
  now: number;
  /** The words a post is called in the list; the default says when it went out. */
  titleOf?: (postId: string, postedAt: string) => string;
}

const isSent = (e: PostedLog[string]): boolean => e.skipped !== true && e.duplicateOf === undefined && e.reason === undefined && e.remoteId !== '' && !['held', 'duplicate', 'account-disconnected'].includes(e.remoteId);
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export async function collectInbox(input: InboxCollectInput): Promise<{ file: InboxFile; report: InboxCollectReport }> {
  const { channels, posted, key, readers, now } = input;
  const today = dayOf(now);
  const report: InboxCollectReport = { posts: 0, comments: 0, reconnect: [], failures: [] };
  const byId = new Map(channels.filter((c) => c.platform === 'instagram' || c.platform === 'facebook').map((c) => [c.id, c] as const));
  let file = tidy(input.file, new Set(byId.keys()), now);
  /** A channel that was refused is probed with one post per check, so it recovers soon after the account is connected again. */
  const probed = new Set<string>();

  for (const [logKey, entry] of Object.entries(posted)) {
    const channelId = logKey.slice(logKey.lastIndexOf('|') + 1);
    const postId = logKey.slice(0, logKey.lastIndexOf('|'));
    const channel = byId.get(channelId);
    if (!channel || !isSent(entry)) continue;
    const age = now - Date.parse(entry.postedAt);
    if (Number.isNaN(age) || age > WATCH_DAYS * DAY_MS) continue;
    if (age > FRESH_DAYS * DAY_MS && file.postsChecked[logKey]?.slice(0, 10) === today) continue;
    if (file.channels[channelId]?.needs === 'reconnect') {
      if (probed.has(channelId)) continue;
      probed.add(channelId);
    }
    try {
      const token = channelToken(channel, key);
      const reading = channel.platform === 'instagram' ? await readers.instagramComments(entry.remoteId, token) : await readers.facebookComments(entry.remoteId, (channel as Extract<Channel, { platform: 'facebook' }>).pageId, token);
      if (reading.needs) {
        file = markChannel(file, channelId, 'reconnect', now);
        probed.add(channelId);
        if (!report.reconnect.includes(channelId)) report.reconnect.push(channelId);
        continue;
      }
      file = markChannel(file, channelId, null, now);
      const before = Object.keys(file.items).length;
      file = addComments(file, { brand: channel.brand, channel: channelId, platform: channel.platform as 'instagram' | 'facebook', post: { id: postId, title: input.titleOf?.(postId, entry.postedAt) ?? `Post of ${entry.postedAt.slice(0, 10)}`, permalink: entry.permalink } }, reading.comments, now);
      report.comments += Object.keys(file.items).length - before;
      report.posts += 1;
      file = { ...file, postsChecked: { ...file.postsChecked, [logKey]: new Date(now).toISOString() } };
    } catch (error) {
      report.failures.push({ id: logKey, reason: reasonOf(error) });
    }
  }
  return { file: { ...file, checkedAt: new Date(now).toISOString() }, report };
}
