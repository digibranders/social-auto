import { NO_PAUSES, type PauseFile } from './pauses.js';
import { crosspostStatusFor, type CrosspostStatus } from './crosspost.js';
import { channelsFor, postedKey, type ChannelFile, type PostedLog } from './channels.js';
import { toScheduled, type ManualPost } from './manual.js';
import type { ScheduledPost } from './schedule.js';
import { dueWindowFor } from './schedule.js';
import { PLATFORMS } from './variants.js';

export type PostState = 'scheduled' | 'due' | 'published' | 'missed' | 'skipped' | 'paused' | 'held';

/** One overall state for a post that goes to several channels: published only when every channel has it. */
export function overallState(channels: readonly Pick<{ state: CrosspostStatus['state'] | 'held' }, 'state'>[], at: number, now: number): PostState {
  if (channels.length === 0) return at > now ? 'scheduled' : 'missed';
  // A channel that was skipped does not count: the post is as published as the channels it was meant for.
  const meant = channels.filter((c) => c.state !== 'skipped');
  if (meant.length === 0) return 'skipped';
  if (meant.every((c) => c.state === 'published')) return 'published';
  if (meant.some((c) => c.state === 'missed')) return 'missed';
  if (meant.some((c) => c.state === 'due')) return 'due';
  // Held only when every target is held: while another network is still to be sent, the post is not on hold, and the held one is shown in `targets`.
  if (meant.every((c) => c.state === 'held')) return 'held';
  if (meant.some((c) => c.state === 'paused')) return 'paused';
  return 'scheduled';
}

const isPlatformName = (value: string): boolean => value === 'instagram' || value === 'facebook' || value === 'linkedin' || value === 'google';

/**
 * What a post is aimed at that is no longer there: an account (an id) that is not connected, or a whole platform (a bare name, which is how written-and-approved
 * posts name where they go) with no connected account at all. The team's own Instagram is not a customer's account, so a post that is not from a plan does not count it.
 * An account the post has already gone out to is not "gone": it was sent while it was connected, and moving the account to another workspace later does not undo that.
 */
export const goneAims = (post: Pick<ScheduledPost, 'id' | 'channels' | 'fromPlan'>, connectedIds: ReadonlySet<string>, connectedPlatforms: ReadonlySet<string>, posted: PostedLog = {}): string[] =>
  (post.channels ?? []).filter((c) => (c.includes(':') ? !connectedIds.has(c) && posted[postedKey(post.id, c)] === undefined : isPlatformName(c) && !connectedPlatforms.has(c) && (c !== 'instagram' || post.fromPlan === true)));

export interface Target {
  id: string;
  platform: string;
  /** The account's name; null for one that is no longer connected. */
  account: string | null;
  state: CrosspostStatus['state'] | 'held';
  permalink: string | null;
  /** Why a target is held or missed when the account is not connected (`ACCOUNT_DISCONNECTED`). */
  code?: 'ACCOUNT_DISCONNECTED';
}

/**
 * Where a post is meant to go: every connected account it goes to, and every account it was aimed at that is no longer connected. A post aimed at an
 * account that was disconnected is held (not lost): connecting the same account again lets it go out while its time window is still open; after that it is missed.
 */
export function targetsOf(post: ScheduledPost, states: readonly CrosspostStatus[], connectedIds: ReadonlySet<string>, now: number, connectedPlatforms: ReadonlySet<string> = new Set(), posted: PostedLog = {}): Target[] {
  const at = Date.parse(post.date);
  const known = states.map((s): Target => ({ id: s.id, platform: s.platform, account: s.account, state: s.state, permalink: s.permalink }));
  const gone = goneAims(post, connectedIds, connectedPlatforms, posted);
  // Accounts the post already went out to but that are not connected to this workspace any more (moved or disconnected): still published.
  const sentThere = (post.channels ?? []).filter((c) => c.includes(':') && !connectedIds.has(c) && posted[postedKey(post.id, c)] !== undefined);
  return [
    ...known,
    ...sentThere.map((id): Target => {
      const done = posted[postedKey(post.id, id)];
      return { id, platform: id.slice(0, id.indexOf(':')), account: null, state: done?.skipped ? 'skipped' : 'published', permalink: done?.skipped ? null : (done?.permalink ?? null) };
    }),
    ...gone.map((id): Target => ({
      id,
      platform: id.includes(':') ? id.slice(0, id.indexOf(':')) : id,
      account: null,
      // A skipped post goes nowhere, so there is nothing to hold; otherwise it waits for the account until its window has passed.
      state: post.skipped === true ? 'skipped' : at > now || now - at < dueWindowFor(post) ? 'held' : 'missed',
      permalink: null,
      code: 'ACCOUNT_DISCONNECTED',
    })),
  ];
}

/**
 * A post as a product sees it: when, what, the picture, and where it stands on each channel. Works for a post the
 * content job planned as well as one made by hand. `origin` is where pictures are served from.
 */
export function scheduledView(post: ScheduledPost, channels: ChannelFile, posted: PostedLog, now: number, origin?: string, pauses: PauseFile = NO_PAUSES): Record<string, unknown> {
  const states = crosspostStatusFor(post, channels, posted, now, pauses);
  const connected = channelsFor(channels, post.brand ?? 'default');
  const connectedIds = new Set(connected.map((c) => c.id));
  const connectedPlatforms = new Set<string>(connected.map((c) => c.platform));
  return {
    id: post.id,
    date: post.date,
    caption: post.caption,
    ...(post.image && origin ? { imageUrl: `${origin}${post.image}` } : {}),
    ...(post.images && origin ? { imageUrls: post.images.map((path) => `${origin}${path}`) } : {}),
    manual: post.manual === true,
    // Only the platforms that have a version of their own are listed; the others use the main caption and picture.
    ...(post.variants ? { variants: Object.fromEntries(PLATFORMS.flatMap((p) => { const v = post.variants?.[p]; return v ? [[p, { ...(v.caption !== undefined ? { caption: v.caption } : {}), ...(v.image && origin ? { imageUrl: `${origin}${v.image}` } : {}) }]] : []; })) } : {}),
    state: overallState(targetsOf(post, states, connectedIds, now, connectedPlatforms, posted), Date.parse(post.date), now),
    channels: states.map((s) => ({ id: s.id, platform: s.platform, account: s.account, state: s.state, permalink: s.permalink })),
    targets: targetsOf(post, states, connectedIds, now, connectedPlatforms, posted),
  };
}

/** A hand-made post as a product sees it (see scheduledView). */
export const postView = (post: ManualPost, channels: ChannelFile, posted: PostedLog, now: number, origin?: string, pauses: PauseFile = NO_PAUSES): Record<string, unknown> =>
  scheduledView(toScheduled(post), channels, posted, now, origin, pauses);
