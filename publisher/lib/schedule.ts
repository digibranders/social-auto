export interface ScheduledPost {
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
    return p as unknown as ScheduledPost;
  });
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
