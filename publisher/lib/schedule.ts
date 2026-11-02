export interface ScheduledPost {
  /** Client the post belongs to; posts without one count as a single "default" client. */
  brand?: string;
  id: string;
  /** ISO 8601 with offset, e.g. 2026-10-29T10:00:00+05:30 */
  date: string;
  caption: string;
  /** Path under the deployment, e.g. /posts/w01-d1.jpg. Null once the poster was pruned (old posts). */
  image: string | null;
  /** Added by hand in the dashboard rather than planned by the content job. */
  manual?: boolean;
  /** Where it goes: "instagram" and/or channel ids such as "linkedin:abc". Missing means every connected channel. */
  channels?: string[];
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleError';
  }
}

/** A post is due from its scheduled time until this long after it (covers Vercel Hobby's hourly cron window). */
export const DUE_WINDOW_MS = 20 * 60 * 60 * 1000;

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
    return p as unknown as ScheduledPost;
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
      return p.image !== null && at <= now && now - at < DUE_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return due[0] ?? null;
}

/** Hand-made posts whose time has passed within the due window. Unlike planned posts, several can go out on one day. */
export function dueManualPosts(posts: ScheduledPost[], now: number): ScheduledPost[] {
  return posts
    .filter((p) => p.manual === true && p.image !== null && Date.parse(p.date) <= now && now - Date.parse(p.date) < DUE_WINDOW_MS)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

/** Whether a post is meant for this channel ("instagram" or a channel id). */
export const isWantedOn = (post: { channels?: string[] }, channel: string): boolean => !post.channels || post.channels.includes(channel);

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

export type PostState = 'published' | 'scheduled' | 'due' | 'missed' | 'unknown';

export interface StatusPost {
  id: string;
  brand: string;
  /** The first channel the post goes to (Instagram, unless a hand-made post skips it). */
  platform: 'instagram' | 'facebook' | 'linkedin';
  date: string;
  caption: string;
  /** Absolute poster URL, or null once the poster was pruned. */
  image: string | null;
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
  crossposts: Array<{ platform: 'instagram' | 'facebook' | 'linkedin'; account: string; state: 'published' | 'scheduled' | 'due' | 'missed'; permalink: string | null }>;
}

export interface StatusSummary {
  posts: StatusPost[];
  runway: Array<{ brand: string; postsLeft: number }>;
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
    const onInstagram = isWantedOn(post, 'instagram');
    const match = onInstagram ? (media?.find((m) => !used.has(m.id) && sameCaption(m.caption, post.caption)) ?? null) : null;
    if (match) used.add(match.id);

    let state: PostState;
    if (match) state = 'published';
    else if (at > now) state = 'scheduled';
    else if (onInstagram && media === null) state = 'unknown';
    else if (now - at < DUE_WINDOW_MS) state = 'due';
    else state = 'missed';

    return {
      id: post.id,
      brand: post.brand ?? 'default',
      platform: 'instagram',
      date: post.date,
      caption: post.caption,
      image: post.image ? `${origin}${post.image}` : null,
      state,
      permalink: match?.permalink ?? null,
      publishedAt: match?.timestamp ?? null,
      mediaUrl: match?.mediaUrl ?? null,
      edited: post.edited === true,
      editable: state === 'scheduled',
      manual: post.manual === true,
      channels: post.channels ?? null,
      crossposts: [],
    };
  });
  const runway = [...postsLeftByBrand(posts, now).entries()].map(([brand, postsLeft]) => ({ brand, postsLeft }));
  return { posts: statusPosts, runway };
}
