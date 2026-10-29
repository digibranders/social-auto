export interface ScheduledPost {
  /** Client the post belongs to; posts without one count as a single "default" client. */
  brand?: string;
  id: string;
  /** ISO 8601 with offset, e.g. 2026-10-29T10:00:00+05:30 */
  date: string;
  caption: string;
  /** Path under the deployment, e.g. /posts/w01-d1.jpg */
  image: string;
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
    for (const key of ['id', 'date', 'caption', 'image'] as const) {
      if (typeof p[key] !== 'string' || !p[key]) throw new ScheduleError(`posts[${i}].${key} must be a non-empty string`);
    }
    if (Number.isNaN(Date.parse(p['date'] as string))) throw new ScheduleError(`posts[${i}].date is not a valid date`);
    if (p['brand'] !== undefined && typeof p['brand'] !== 'string') {
      throw new ScheduleError(`posts[${i}].brand must be a string`);
    }
    return p as unknown as ScheduledPost;
  });
}

/** Warn when a client has exactly this many posts left to publish (one post a day). */
export const LOW_QUEUE_WARN_AT: readonly number[] = [7, 3, 1, 0];

export interface LowQueueWarning {
  brand: string;
  postsLeft: number;
}

/**
 * Clients whose schedule is about to run out. Posts that were due recently still count towards
 * "known" clients, so the final post's day reports 0 left instead of the client vanishing.
 */
export function lowQueueWarnings(posts: ScheduledPost[], now: number): LowQueueWarning[] {
  const left = new Map<string, number>();
  for (const post of posts) {
    const brand = post.brand ?? 'default';
    left.set(brand, (left.get(brand) ?? 0) + (Date.parse(post.date) > now ? 1 : 0));
  }
  return [...left.entries()]
    .filter(([, postsLeft]) => LOW_QUEUE_WARN_AT.includes(postsLeft))
    .map(([brand, postsLeft]) => ({ brand, postsLeft }));
}

/** The latest post whose time has passed within the due window, if any. */
export function duePost(posts: ScheduledPost[], now: number): ScheduledPost | null {
  const due = posts
    .filter((p) => {
      const at = Date.parse(p.date);
      return at <= now && now - at < DUE_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return due[0] ?? null;
}

/** Instagram may normalise whitespace, so compare captions loosely. */
export function sameCaption(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}
