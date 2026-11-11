/** Which days of the week a client posts on. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The days used for "N posts a week", spread as evenly through the week as whole days allow. */
const EVEN_SPREAD: Record<number, readonly Weekday[]> = {
  1: ['mon'],
  2: ['mon', 'thu'],
  3: ['mon', 'wed', 'fri'],
  4: ['mon', 'tue', 'thu', 'fri'],
  5: ['mon', 'tue', 'wed', 'thu', 'fri'],
  6: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
  7: WEEKDAYS,
};

/**
 * The days used for "N posts a week" when the first post must fall on a given day: that day, then the others spread as evenly through the week as whole
 * days allow (two a week from a Wednesday is Wednesday and Saturday). The first post is on the start day, never a day later.
 */
export function weekdaysFrom(startDate: string, postsPerWeek: number): Weekday[] {
  if (!Number.isInteger(postsPerWeek) || postsPerWeek < 1 || postsPerWeek > 7) throw new Error(`postsPerWeek must be a whole number from 1 to 7, got ${postsPerWeek}`);
  const first = WEEKDAYS.indexOf(weekdayOf(startDate));
  return Array.from({ length: postsPerWeek }, (_, i) => WEEKDAYS[(first + Math.floor((i * 7) / postsPerWeek)) % 7] as Weekday);
}

export function weekdaysForPostsPerWeek(postsPerWeek: number): readonly Weekday[] {
  const days = EVEN_SPREAD[postsPerWeek];
  if (!days) throw new Error(`postsPerWeek must be a whole number from 1 to 7, got ${postsPerWeek}`);
  return days;
}

/** Checks a list of day names (any case), returns them in week order without repeats. */
export function parseWeekdays(raw: unknown): Weekday[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('weekdays must be a non-empty list like ["mon", "wed"]');
  const chosen = new Set<Weekday>();
  for (const item of raw) {
    const name = typeof item === 'string' ? item.trim().toLowerCase().slice(0, 3) : '';
    const day = WEEKDAYS.find((d) => d === name);
    if (!day) throw new Error(`"${String(item)}" is not a weekday; use mon, tue, wed, thu, fri, sat or sun`);
    chosen.add(day);
  }
  return WEEKDAYS.filter((d) => chosen.has(d));
}

/** The weekday of a YYYY-MM-DD calendar date. */
export function weekdayOf(date: string): Weekday {
  const index = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(index + 6) % 7] as Weekday;
}

/** The next `count` calendar dates from `startDate` (inclusive) that fall on one of `weekdays`. */
export function postDates(startDate: string, count: number, weekdays: readonly Weekday[]): string[] {
  if (weekdays.length === 0) throw new Error('weekdays cannot be empty');
  const dates: string[] = [];
  const first = Date.parse(`${startDate}T00:00:00Z`);
  for (let i = 0; dates.length < count; i++) {
    const date = new Date(first + i * 86_400_000).toISOString().slice(0, 10);
    if (weekdays.includes(weekdayOf(date))) dates.push(date);
  }
  return dates;
}
