/**
 * Calendar maths and labels. Pure functions only (no page access), so they can be tested.
 * A "day key" is a calendar day written YYYY-MM-DD in the display time zone.
 */
import type { PostState, StatusPost } from '../shared/status.ts';

export const DISPLAY_TIME_ZONE = 'Asia/Kolkata';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar day a moment falls on, in the display time zone. */
export function dayKeyOf(moment: string | number | Date): string {
  const parts = dayFormatter.formatToParts(new Date(moment));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function toUtc(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(key: string, days: number): string {
  const date = toUtc(key);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

/** The first day of the month `months` away from the given day. */
export function addMonths(key: string, months: number): string {
  const date = toUtc(key);
  return fromUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)));
}

/** The Monday of the week containing the day. */
export function weekStart(key: string): string {
  const weekday = toUtc(key).getUTCDay(); // 0 = Sunday
  return addDays(key, -((weekday + 6) % 7));
}

export function weekDays(key: string): string[] {
  const start = weekStart(key);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function monthOf(key: string): string {
  return key.slice(0, 7);
}

/** Weeks (Monday first) that cover the month containing the day, including spill-over days. */
export function monthGrid(key: string): string[][] {
  const first = `${monthOf(key)}-01`;
  const last = addDays(addMonths(first, 1), -1);
  const weeks: string[][] = [];
  for (let start = weekStart(first); start <= last; start = addDays(start, 7)) {
    weeks.push(weekDays(start));
  }
  return weeks;
}

/** Posts grouped by calendar day, each day's posts in time order. */
export function groupByDay(posts: StatusPost[]): Map<string, StatusPost[]> {
  const groups = new Map<string, StatusPost[]>();
  for (const post of [...posts].sort((a, b) => Date.parse(a.date) - Date.parse(b.date))) {
    const key = dayKeyOf(post.date);
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  return groups;
}

const timeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: DISPLAY_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const dateTimeFormatter = new Intl.DateTimeFormat('en-IN', {
  timeZone: DISPLAY_TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const dayLabelFormatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const weekdayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });
const monthFormatter = new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const hourLabelFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true });
const clockFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: DISPLAY_TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "10:00 AM": uppercase, to match the hour labels of the grid. */
export const formatTime = (moment: string | number | Date): string => timeFormatter.format(new Date(moment)).toUpperCase();
export const formatDateTime = (moment: string | number | Date): string => dateTimeFormatter.format(new Date(moment));
export const formatDayLabel = (key: string): string => dayLabelFormatter.format(toUtc(key));
export const formatMonth = (key: string): string => monthFormatter.format(toUtc(key));
export const weekdayName = (key: string): string => weekdayFormatter.format(toUtc(key));

/** "2026-10-26" -> "10/26/2026", as shown above each column of the hourly grid. */
export function formatDayHeader(key: string): string {
  const [year, month, day] = key.split('-');
  return `${month}/${day}/${year}`;
}

/** "10:00 AM" for hour 10, "12:00 AM" for hour 0. */
export const formatHourLabel = (hour: number): string => hourLabelFormatter.format(new Date(Date.UTC(2000, 0, 1, hour)));

/** The hour of day (0-23) a moment falls in, in the display time zone. */
export function hourOf(moment: string | number | Date): number {
  const [hour = '0'] = clockFormatter.format(new Date(moment)).split(':');
  return Number(hour) % 24;
}

/** The minute within the hour (0-59), in the display time zone. */
export function minuteOf(moment: string | number | Date): number {
  const [, minute = '0'] = clockFormatter.format(new Date(moment)).split(':');
  return Number(minute);
}

/** "brandbasket" -> "Brandbasket", "cafe-moon" -> "Cafe Moon" */
export function brandLabel(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** A stable colour per client: the same slug always gives the same hue. */
export function brandHue(slug: string): number {
  let hue = 0;
  for (const char of slug) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return hue;
}

const STATE_LABELS: Record<PostState, string> = {
  published: 'Published',
  scheduled: 'Scheduled',
  due: 'Due now',
  missed: 'Missed',
  unknown: 'Unknown',
  skipped: 'Skipped',
  paused: 'Paused',
};
export const stateLabel = (state: PostState): string => STATE_LABELS[state];

/** Marks that carry the meaning without relying on colour. */
const STATE_MARKS: Record<PostState, string> = { published: '✓', scheduled: '◷', due: '●', missed: '!', unknown: '?', skipped: '⊘', paused: '‖' };
export const stateMark = (state: PostState): string => STATE_MARKS[state];

/**
 * Only https links are ever put into the page. `ownOrigin` additionally allows links to the page's
 * own address, which is how images load on the plain-http development server.
 */
export function safeHttpsUrl(value: string | null, ownOrigin?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (ownOrigin !== undefined && url.origin === ownOrigin) ? url.href : null;
  } catch {
    return null;
  }
}

/** Instagram's limits on a caption; the publisher enforces the same ones. */
export const MAX_CAPTION_LENGTH = 2200;
export const MAX_HASHTAGS = 30;

export function captionStats(text: string): { length: number; hashtags: number } {
  return { length: text.trim().length, hashtags: text.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0 };
}

/** Why a caption cannot be saved, or null when it is fine. */
export function captionProblem(text: string): string | null {
  const { length, hashtags } = captionStats(text);
  if (length === 0) return 'The caption cannot be empty.';
  if (length > MAX_CAPTION_LENGTH) return `The caption is ${length - MAX_CAPTION_LENGTH} characters too long.`;
  if (hashtags > MAX_HASHTAGS) return `Instagram allows ${MAX_HASHTAGS} hashtags; this has ${hashtags}.`;
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A post can be set up to this many days ahead (the publisher allows 90 from now). */
export const MAX_DAYS_AHEAD = 89;
const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * The time (HH:MM, India) a post would have if dropped on this hour of the hourly grid, or on a day (hour null): a post made by hand
 * takes the hour it is dropped on and keeps its minutes; a planned post always keeps its own time, which the daily run sends it at.
 */
export function dropTime(post: Pick<StatusPost, 'date' | 'manual'>, hour: number | null): string {
  return post.manual && hour !== null ? `${pad2(hour)}:${pad2(minuteOf(post.date))}` : `${pad2(hourOf(post.date))}:${pad2(minuteOf(post.date))}`;
}

/**
 * Whether a post may be dropped on this day (and hour): onto a moment still ahead and within 90 days, never where it already is, and
 * (for a planned post) never onto a day that already has a planned post of its client, because the daily run sends only one a day.
 */
export function mayLandOn(post: StatusPost, day: string, hour: number | null, others: readonly StatusPost[], now: number): boolean {
  const time = dropTime(post, hour);
  const moment = Date.parse(`${day}T${time}:00+05:30`);
  if (Number.isNaN(moment) || moment <= now || moment > now + MAX_DAYS_AHEAD * DAY_MS) return false;
  if (day === dayKeyOf(post.date) && time === dropTime(post, null)) return false;
  if (!post.manual && others.some((p) => p.id !== post.id && !p.manual && p.brand === post.brand && dayKeyOf(p.date) === day)) return false;
  return true;
}
