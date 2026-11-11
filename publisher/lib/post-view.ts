import { NO_PAUSES, type PauseFile } from './pauses.js';
import { crosspostStatusFor, type CrosspostStatus } from './crosspost.js';
import type { ChannelFile, PostedLog } from './channels.js';
import { toScheduled, type ManualPost } from './manual.js';
import type { ScheduledPost } from './schedule.js';
import { PLATFORMS } from './variants.js';

export type PostState = 'scheduled' | 'due' | 'published' | 'missed' | 'skipped' | 'paused';

/** One overall state for a post that goes to several channels: published only when every channel has it. */
export function overallState(channels: readonly Pick<CrosspostStatus, 'state'>[], at: number, now: number): PostState {
  if (channels.length === 0) return at > now ? 'scheduled' : 'missed';
  // A channel that was skipped does not count: the post is as published as the channels it was meant for.
  const meant = channels.filter((c) => c.state !== 'skipped');
  if (meant.length === 0) return 'skipped';
  if (meant.every((c) => c.state === 'published')) return 'published';
  if (meant.some((c) => c.state === 'missed')) return 'missed';
  if (meant.some((c) => c.state === 'due')) return 'due';
  if (meant.some((c) => c.state === 'paused')) return 'paused';
  return 'scheduled';
}

/**
 * A post as a product sees it: when, what, the picture, and where it stands on each channel. Works for a post the
 * content job planned as well as one made by hand. `origin` is where pictures are served from.
 */
export function scheduledView(post: ScheduledPost, channels: ChannelFile, posted: PostedLog, now: number, origin?: string, pauses: PauseFile = NO_PAUSES): Record<string, unknown> {
  const states = crosspostStatusFor(post, channels, posted, now, pauses);
  return {
    id: post.id,
    date: post.date,
    caption: post.caption,
    ...(post.image && origin ? { imageUrl: `${origin}${post.image}` } : {}),
    ...(post.images && origin ? { imageUrls: post.images.map((path) => `${origin}${path}`) } : {}),
    manual: post.manual === true,
    // Only the platforms that have a version of their own are listed; the others use the main caption and picture.
    ...(post.variants ? { variants: Object.fromEntries(PLATFORMS.flatMap((p) => { const v = post.variants?.[p]; return v ? [[p, { ...(v.caption !== undefined ? { caption: v.caption } : {}), ...(v.image && origin ? { imageUrl: `${origin}${v.image}` } : {}) }]] : []; })) } : {}),
    state: overallState(states, Date.parse(post.date), now),
    channels: states.map((s) => ({ id: s.id, platform: s.platform, account: s.account, state: s.state, permalink: s.permalink })),
  };
}

/** A hand-made post as a product sees it (see scheduledView). */
export const postView = (post: ManualPost, channels: ChannelFile, posted: PostedLog, now: number, origin?: string, pauses: PauseFile = NO_PAUSES): Record<string, unknown> =>
  scheduledView(toScheduled(post), channels, posted, now, origin, pauses);
