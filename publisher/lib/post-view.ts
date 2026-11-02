import { crosspostStatusFor, type CrosspostStatus } from './crosspost.js';
import type { ChannelFile, PostedLog } from './channels.js';
import { toScheduled, type ManualPost } from './manual.js';
import type { ScheduledPost } from './schedule.js';

export type PostState = 'scheduled' | 'due' | 'published' | 'missed';

/** One overall state for a post that goes to several channels: published only when every channel has it. */
export function overallState(channels: readonly Pick<CrosspostStatus, 'state'>[], at: number, now: number): PostState {
  if (channels.length === 0) return at > now ? 'scheduled' : 'missed';
  if (channels.every((c) => c.state === 'published')) return 'published';
  if (channels.some((c) => c.state === 'missed')) return 'missed';
  if (channels.some((c) => c.state === 'due')) return 'due';
  return 'scheduled';
}

/**
 * A post as a product sees it: when, what, the picture, and where it stands on each channel. Works for a post the
 * content job planned as well as one made by hand. `origin` is where pictures are served from.
 */
export function scheduledView(post: ScheduledPost, channels: ChannelFile, posted: PostedLog, now: number, origin?: string): Record<string, unknown> {
  const states = crosspostStatusFor(post, channels, posted, now);
  return {
    id: post.id,
    date: post.date,
    caption: post.caption,
    ...(post.image && origin ? { imageUrl: `${origin}${post.image}` } : {}),
    manual: post.manual === true,
    state: overallState(states, Date.parse(post.date), now),
    channels: states.map((s) => ({ platform: s.platform, account: s.account, state: s.state, permalink: s.permalink })),
  };
}

/** A hand-made post as a product sees it (see scheduledView). */
export const postView = (post: ManualPost, channels: ChannelFile, posted: PostedLog, now: number, origin?: string): Record<string, unknown> =>
  scheduledView(toScheduled(post), channels, posted, now, origin);
