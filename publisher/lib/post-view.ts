import { crosspostStatusFor, type CrosspostStatus } from './crosspost.js';
import type { ChannelFile, PostedLog } from './channels.js';
import { toScheduled, type ManualPost } from './manual.js';

export type PostState = 'scheduled' | 'due' | 'published' | 'missed';

/** One overall state for a post that goes to several channels: published only when every channel has it. */
export function overallState(channels: readonly Pick<CrosspostStatus, 'state'>[], at: number, now: number): PostState {
  if (channels.length === 0) return at > now ? 'scheduled' : 'missed';
  if (channels.every((c) => c.state === 'published')) return 'published';
  if (channels.some((c) => c.state === 'missed')) return 'missed';
  if (channels.some((c) => c.state === 'due')) return 'due';
  return 'scheduled';
}

/** A hand-made post as a product sees it: when, what, and where it stands on each channel. */
export function postView(post: ManualPost, channels: ChannelFile, posted: PostedLog, now: number): Record<string, unknown> {
  const scheduled = toScheduled(post);
  const states = crosspostStatusFor(scheduled, channels, posted, now);
  return {
    id: post.id,
    date: post.date,
    caption: post.caption,
    state: overallState(states, Date.parse(post.date), now),
    channels: states.map((s) => ({ platform: s.platform, account: s.account, state: s.state, permalink: s.permalink })),
  };
}
