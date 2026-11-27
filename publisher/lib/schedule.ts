import type { Channel } from './channels.js';
import { forPlatform, PLATFORMS, type Variants } from './variants.js';
/** A carousel shows between two and ten pictures. */
export const MIN_CAROUSEL_PICTURES = 2;
export const MAX_CAROUSEL_PICTURES = 10;

export interface ScheduledPost {
  /** Client the post belongs to; posts without one count as a single "default" client. */
  brand?: string;
  id: string;
  /** ISO 8601 with offset, e.g. 2026-10-29T10:00:00+05:30 */
  date: string;
  caption: string;
  /** Path under the deployment, e.g. /posts/w01-d1.jpg. Null once the poster was pruned (old posts). */
  image: string | null;
  /** A carousel: two to ten pictures shown together, in order. `image` is the first of them (the cover). Absent for a post with one picture. */
  images?: string[];
  /** Added by hand in the dashboard rather than planned by the content job. */
  manual?: boolean;
  /** Where it goes: "instagram" and/or channel ids such as "linkedin:abc" or "google:123". Missing means every connected channel. */
  channels?: string[];
  /** Own caption and/or picture for a platform; a platform without one uses the main caption and picture. */
  variants?: Variants;
  /** Skipped in the dashboard: it stays on the calendar but is never sent. */
  skipped?: boolean;
  /** A planned post given a day or time of its own in the dashboard: like a hand-made post, the frequent run sends it at that time. */
  ownTime?: boolean;
  /** Made from a client's posting plan. It goes only to that client's own connected channels, never to the team's one shared Instagram account, so a poster can never land on another client's account. */
  fromPlan?: boolean;
  /** Set on a post made by splitting another by network time (see overrides.ts): the id of the post it was split from. Never in the schedule file. */
  splitOf?: string;
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/** A post is due from its scheduled time until this long after it (covers Vercel Hobby's hourly cron window). */
export const DUE_WINDOW_MS = 20 * 60 * 60 * 1000;

/**
 * A post with a time of its own (made by hand, or from a posting plan) is meant for that time: it is sent within this long after it, and a day later is too late
 * for it, so it is missed rather than posted the next morning. It is twice the frequent run's look-back, so one late tick does not lose it.
 */
export const OWN_TIME_WINDOW_MS = 30 * 60 * 1000;

/** How long after its time a post may still be sent: the day's run covers a plain planned post, a post with its own time has a short window. */
export const dueWindowFor = (post: { manual?: boolean; ownTime?: boolean }): number => (post.manual === true || post.ownTime === true ? OWN_TIME_WINDOW_MS : DUE_WINDOW_MS);

export function parseSchedule(raw: unknown): ScheduledPost[] {
  const posts = (raw as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) throw new ScheduleError('schedule.json must contain a "posts" array');
  return posts.map((p: Record<string, unknown>, i) => {
    for (const key of ['id', 'date', 'caption'] as const) {
      if (typeof p[key] !== 'string' || !p[key]) throw new ScheduleError(`posts[${i}].${key} must be a non-empty string`);
    }
    if (p['image'] !== null && (typeof p['image'] !== 'string' || !p['image'])) {
      throw new ScheduleError(`posts[${i}].image must be a non-empty string or null`);
    }
    if (Number.isNaN(Date.parse(p['date'] as string))) throw new ScheduleError(`posts[${i}].date is not a valid date`);
    if (p['brand'] !== undefined && typeof p['brand'] !== 'string') {
      throw new ScheduleError(`posts[${i}].brand must be a string`);
    }
    if (p['images'] === undefined) return p as unknown as ScheduledPost;
    const images = p['images'];
    if (!Array.isArray(images) || images.length < MIN_CAROUSEL_PICTURES || images.length > MAX_CAROUSEL_PICTURES || images.some((entry) => typeof entry !== 'string' || !entry)) {
      throw new ScheduleError(`posts[${i}].images must be a list of ${MIN_CAROUSEL_PICTURES} to ${MAX_CAROUSEL_PICTURES} non-empty strings`);
    }
    if (typeof p['image'] === 'string' && p['image'] !== images[0]) throw new ScheduleError(`posts[${i}].image must be the first of images`);
    return { ...p, image: images[0] } as unknown as ScheduledPost;
  });
}

/** Posts still to come, per client (one post a day, so this is also the days of posts left). */
export function postsLeftByBrand(posts: ScheduledPost[], now: number): Map<string, number> {
  const left = new Map<string, number>();
  for (const post of posts) {
    if (post.manual) continue; // extra posts do not count towards the planned runway
    const brand = post.brand ?? 'default';
    left.set(brand, (left.get(brand) ?? 0) + (Date.parse(post.date) > now ? 1 : 0));
  }
  return left;
}

/** Warn when a client has exactly this many posts left to publish (one post a day). */
export const LOW_QUEUE_WARN_AT: readonly number[] = [7, 3, 1, 0];

export interface LowQueueWarning {
  brand: string;
  postsLeft: number;
}

/**
 * Clients whose schedule is about to run out. Every post ever scheduled counts towards the "known"
 * clients, so the final post's day reports 0 left instead of the client vanishing.
 */
export function lowQueueWarnings(posts: ScheduledPost[], now: number): LowQueueWarning[] {
  return [...postsLeftByBrand(posts, now).entries()]
    .filter(([, postsLeft]) => LOW_QUEUE_WARN_AT.includes(postsLeft))
    .map(([brand, postsLeft]) => ({ brand, postsLeft }));
}

/** The latest post whose time has passed within the due window, if any. Posts without a poster cannot be sent. */
export function duePost(posts: ScheduledPost[], now: number): ScheduledPost | null {
  const due = posts
    .filter((p) => {
      const at = Date.parse(p.date);
      return p.image !== null && at <= now && now - at < dueWindowFor(p);
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return due[0] ?? null;
}

/**
 * The planned post to send now: the latest one whose time has passed, unless it was skipped. A skipped post is chosen first and then
 * dropped, so that skipping today's post does not bring yesterday's back.
 */
export function duePlannedPost(posts: ScheduledPost[], now: number): ScheduledPost | null {
  const due = duePost(posts, now);
  return due !== null && due.skipped === true ? null : due;
}

/**
 * Posts with a time of their own whose time has passed within the due window: those made by hand, and planned posts that were moved or
 * given a time in the dashboard. Unlike the plain planned posts (one a day, at the daily run), several can go out on one day.
 */
export function dueManualPosts(posts: ScheduledPost[], now: number, windowMs: number = OWN_TIME_WINDOW_MS): ScheduledPost[] {
  return posts
    .filter((p) => (p.manual === true || p.ownTime === true) && p.skipped !== true && p.image !== null && Date.parse(p.date) <= now && now - Date.parse(p.date) < windowMs)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/**
 * Whether a post is meant for this channel. A post's `channels` may name channels by id or whole platforms ("instagram", "facebook", "linkedin", "google"),
 * which is how a campaign says "post on Instagram and Facebook" without knowing the ids; missing means every connected channel.
 */
export const isWantedOn = (post: { channels?: string[] }, channel: string, platform?: string): boolean =>
  !post.channels || post.channels.includes(channel) || (platform !== undefined && post.channels.includes(platform));

/**
 * Whether the team's own Instagram account (the one shared account behind the channel "instagram") is a target of this post. A post made from a client's
 * posting plan never uses it, whatever platform names it lists: that account carries the clients the team plans for itself, and a plan names a platform
 * only to mean the client's own account on it.
 */
export const usesTeamInstagram = (post: { channels?: string[]; fromPlan?: boolean }): boolean => post.fromPlan !== true && isWantedOn(post, 'instagram');

/** Instagram may normalise whitespace, so compare captions loosely. */
export function sameCaption(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

/** A post seen on the Instagram account. */
export interface MediaItem {
  id: string;
  caption: string;
  timestamp: string;
  permalink: string;
  mediaUrl: string | null;
}

export type PostState = 'published' | 'scheduled' | 'due' | 'missed' | 'unknown' | 'skipped' | 'paused';

export interface StatusPost {
  id: string;
  brand: string;
  /** The first channel the post goes to (Instagram, unless a hand-made post skips it). */
  platform: Channel['platform'];
  date: string;
  caption: string;
  /** Absolute poster URL, or null once the poster was pruned. */
  image: string | null;
  /** A carousel: the absolute URL of every picture, in order. Absent for a plain post. */
  images?: string[];
  state: PostState;
  permalink: string | null;
  publishedAt: string | null;
  /** The picture as Instagram serves it (temporary link); used when the poster is gone. */
  mediaUrl: string | null;
  /** The caption or picture was changed in the dashboard after the content job planned it. */
  edited: boolean;
  /** Still ahead of its time and not yet on Instagram, so the dashboard may change it. */
  editable: boolean;
  /** Where the post stands on the client's other channels (Facebook Pages). Filled in by the status feed. */
  /** Added by hand in the dashboard. */
  manual: boolean;
  /** Where a hand-made post goes ('instagram' and channel ids); null for planned posts, which go everywhere. */
  channels: string[] | null;
  /** The platforms that have a caption and/or picture of their own (picture as an absolute URL); the main caption and picture stand for the rest. */
  variants?: Partial<Record<Channel['platform'], { caption?: string; image?: string }>>;
  crossposts: Array<{ platform: Channel['platform']; account: string; state: 'published' | 'scheduled' | 'due' | 'missed' | 'skipped' | 'paused'; permalink: string | null }>;
}

export interface StatusSummary {
  posts: StatusPost[];
  runway: Array<{ brand: string; postsLeft: number; /** Added in the dashboard, so it has no planned posts and can be removed. */ added?: true; /** The name to show, for a client a product created. */ name?: string; /** The product that created it. */ product?: string }>;
}

/**
 * Where every scheduled post stands. `media` is what Instagram currently shows for the account,
 * or null when Instagram could not be reached: then past posts are "unknown" rather than guessed.
 */
export function buildStatus(posts: Array<ScheduledPost & { edited?: boolean }>, media: MediaItem[] | null, now: number, origin: string): StatusSummary {
  const used = new Set<string>();
  // Oldest first, so that when captions repeat the earliest post claims the Instagram post.
  const ordered = [...posts].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const statusPosts = ordered.map((post): StatusPost => {
    const at = Date.parse(post.date);
    const onInstagram = usesTeamInstagram(post);
    const onInstagramAs = forPlatform(post, 'instagram');
    const match = onInstagram ? (media?.find((m) => !used.has(m.id) && sameCaption(m.caption, onInstagramAs.caption)) ?? null) : null;
    if (match) used.add(match.id);

    let state: PostState;
    if (match) state = 'published';
    else if (post.skipped) state = 'skipped';
    else if (at > now) state = 'scheduled';
    else if (onInstagram && media === null) state = 'unknown';
    else if (now - at < dueWindowFor(post)) state = 'due';
    else state = 'missed';

    return {
      id: post.id,
      brand: post.brand ?? 'default',
      platform: 'instagram',
      date: post.date,
      caption: post.caption,
      image: post.image ? `${origin}${post.image}` : null,
      ...(post.images ? { images: post.images.map((path) => `${origin}${path}`) } : {}),
      ...(post.variants ? { variants: Object.fromEntries(PLATFORMS.flatMap((p) => { const v = post.variants?.[p]; return v ? [[p, { ...(v.caption !== undefined ? { caption: v.caption } : {}), ...(v.image ? { image: `${origin}${v.image}` } : {}) }]] : []; })) } : {}),
      state,
      permalink: match?.permalink ?? null,
      publishedAt: match?.timestamp ?? null,
      mediaUrl: match?.mediaUrl ?? null,
      edited: post.edited === true,
      editable: at > now && (state === 'scheduled' || state === 'skipped'),
      manual: post.manual === true,
      channels: post.channels ?? null,
      crossposts: [],
    };
  });
  const runway = [...postsLeftByBrand(posts, now).entries()].map(([brand, postsLeft]) => ({ brand, postsLeft }));
  return { posts: statusPosts, runway };
}
