/**
 * The checks made just before a post is sent to the channels of one platform, beyond "was this exact post sent already":
 *
 *   duplicate           the channel already received a post with the same words in the last week under another post id (lib/duplicates.ts): not sent;
 *   ACCOUNT_DISCONNECTED the post names an exact account that is no longer connected: it is held, never sent to a different account of the client in its place.
 *
 * Pure: it reads the channels, the post and the posted log and says what to leave out, so it is easy to test. The sender acts on the answer.
 */
import { channelLabel, postedKey, type Channel, type ChannelFile, type PostedLog } from './channels.js';
import { targetChannels } from './crosspost.js';
import { findDuplicate, type EarlierPost } from './duplicates.js';

export interface GuardPost {
  id: string;
  brand?: string;
  date: string;
  caption: string;
  channels?: string[];
  fromPlan?: boolean;
}

export interface GuardAnswer {
  /** Channels that already received these words, with the earlier post. */
  duplicates: Array<{ channel: Channel; of: EarlierPost }>;
  /** Exact account ids the post names that are no longer connected, and nothing was said about before. */
  gone: string[];
}

/** An exact account id as a plan names it: the platform, a colon and the account. */
const isAccountId = (value: string, platform: Channel['platform']): boolean => value.startsWith(`${platform}:`);

export function guardChannels(channels: ChannelFile, post: GuardPost, platform: Channel['platform'], log: PostedLog, now: number): GuardAnswer {
  const duplicates = targetChannels(channels, post, platform)
    .filter((channel) => Date.parse(post.date) >= Date.parse(channel.connectedAt) && log[postedKey(post.id, channel.id)] === undefined)
    .flatMap((channel) => {
      const of = findDuplicate(log, channel.id, post.id, post.caption, now);
      return of ? [{ channel, of }] : [];
    });
  const connected = new Set(channels.channels.map((c) => c.id));
  const gone = (post.channels ?? []).filter((id) => isAccountId(id, platform) && !connected.has(id) && log[postedKey(post.id, id)] === undefined);
  return { duplicates, gone };
}

/** What a person reads when a post was not sent because its words were already sent. */
export const duplicateText = (channel: Channel, of: EarlierPost): string =>
  `${channelLabel(channel)}: not sent, because a post with the same words was already sent there on ${of.entry.postedAt.slice(0, 10)}.`;
