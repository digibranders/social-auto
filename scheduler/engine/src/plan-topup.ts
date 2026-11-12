/**
 * A written plan that came out with fewer posts than days (the writer dropped some on its checks) is topped up, and says so: days with no post are filled first from the
 * drafts that passed review but were not chosen (the reserve), then by writing the day once more on its own. A draft is used only when it is not the idea or the headline
 * of a post the plan already has. A day that still has no post stays empty, and the batch remembers the days that were asked for, so a week with no posts can be told.
 */
import type { PlannedPost } from './content.ts';

const norm = (text: string): string => text.replaceAll('|', '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const conceptOf = (post: PlannedPost): string => norm(String((post as { concept?: { subject?: unknown; message?: unknown } }).concept?.message ?? ''));

/** Whether a draft repeats a post the plan already has: the same headline, or the same message. */
export function repeatsOne(draft: PlannedPost, existing: readonly PlannedPost[]): boolean {
  const headline = norm(draft.headline);
  const message = conceptOf(draft);
  return existing.some((p) => norm(p.headline) === headline || (message !== '' && conceptOf(p) === message));
}

export interface TopUpResult {
  posts: PlannedPost[];
  /** The days filled from the reserve, and the days filled by writing them once more. */
  fromReserve: string[];
  written: string[];
  /** The days that still have no post. */
  stillEmpty: string[];
}

export async function topUpPlan(input: {
  posts: readonly PlannedPost[];
  /** The days that were asked for (YYYY-MM-DD). */
  requestedDays: readonly string[];
  /** Drafts that passed review but were not chosen. */
  reserve: readonly PlannedPost[];
  /** Writes one day once more; null when nothing valid came. */
  writeDay: (day: string, existing: readonly PlannedPost[]) => Promise<PlannedPost | null>;
  /** The way a day is written in a post's `date` (the day, then time and offset). */
  dateOf: (day: string) => string;
  /** Names a post after its place in the plan. */
  idOf: (index: number) => string;
  log?: (message: string) => void;
}): Promise<TopUpResult> {
  const log = input.log ?? ((): undefined => undefined);
  let posts = [...input.posts];
  const have = new Set(posts.map((p) => p.date.slice(0, 10)));
  const missing = [...new Set(input.requestedDays)].filter((d) => !have.has(d)).sort();
  const reserve = [...input.reserve];
  const fromReserve: string[] = [];
  const written: string[] = [];
  const stillEmpty: string[] = [];
  for (const day of missing) {
    const at = reserve.findIndex((d) => !repeatsOne(d, posts));
    if (at >= 0) {
      const [draft] = reserve.splice(at, 1) as [PlannedPost];
      posts.push({ ...draft, date: input.dateOf(day) });
      fromReserve.push(day);
      log(`${day}: filled from a draft that passed review but was not chosen`);
      continue;
    }
    let again: PlannedPost | null = null;
    try {
      again = await input.writeDay(day, posts);
    } catch (error) {
      log(`${day}: writing it once more failed (${error instanceof Error ? error.message.slice(0, 120) : String(error)})`);
    }
    if (again && !repeatsOne(again, posts)) {
      posts.push({ ...again, date: input.dateOf(day) });
      written.push(day);
      log(`${day}: written once more`);
    } else {
      stillEmpty.push(day);
      log(`${day}: no post could be written, the day stays empty`);
    }
  }
  posts = posts.sort((a, b) => a.date.localeCompare(b.date)).map((p, i) => ({ ...p, id: input.idOf(i) }));
  return { posts, fromReserve, written, stillEmpty };
}
