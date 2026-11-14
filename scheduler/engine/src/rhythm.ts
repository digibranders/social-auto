/**
 * How often a client posts when the owner does not say otherwise: two posts per channel per week, on days spread through the week. A post goes to every channel
 * the owner approves it for, so the posts of a week are the posts of each of its channels; "weeks" says how many weeks are written at once.
 */
import { parseWeekdays, postDates, weekdayOf, weekdaysForPostsPerWeek, weekdaysFrom, type Weekday } from './cadence.ts';

export const DEFAULT_POSTS_PER_WEEK = 2;
export const MAX_WEEKS = 4;
/** The most posts one written batch may hold (one a day for a month, the plan limit). */
export const MAX_POSTS = 31;

export interface Rhythm {
  /** How many posts to write. */
  days: number;
  /** The days of the week they fall on. */
  weekdays: readonly Weekday[];
}

export class RhythmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RhythmError';
  }
}

const whole = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new RhythmError(`${name} must be a whole number from ${min} to ${max}`);
  return value;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS_ALL: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** How far ahead the first post may be put. */
export const MAX_START_DAYS_AHEAD = 180;

/** The first day of a batch the owner chose: a real day, tomorrow or later in India time (a post for today may already be past its time), and not too far ahead. */
export function checkStartDate(value: unknown, now: number): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RhythmError('startDate must be a day like 2026-12-14');
  const at = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new RhythmError('startDate is not a real day');
  const today = Date.parse(`${new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10)}T00:00:00Z`);
  if (at <= today) throw new RhythmError('startDate must be tomorrow or later (India time)');
  if (at - today > MAX_START_DAYS_AHEAD * DAY_MS) throw new RhythmError(`startDate must be within ${MAX_START_DAYS_AHEAD} days`);
  return value;
}

/** The time of day the posts go out (India time), as HH:MM. */
export function checkTime(value: unknown): string {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new RhythmError('time must be like 10:00 (24 hour, India time)');
  return value;
}

/**
 * The posts to write for a number of weeks at a number of posts a week (two a week for one week when neither is given). With a start day the first post is on
 * that day and the others follow the same spacing; without one the engine chooses the next free day.
 */
/** The last day a plan may reach after its first: four weeks (28 days) counting the start day. */
export const MAX_PLAN_SPAN_DAYS = 27;

/**
 * A plan that stops on a day (a billing month that ends on the renewal day): a post on each chosen day from the start day to the end day, both included, so the last week is short and
 * nothing falls after the end day. The days are the ones asked for, else the usual spread for the posts a week (Monday to Friday for five), whatever day the plan starts on: a plan that
 * starts mid-week simply begins with the first of those days on or after its start.
 */
function rhythmUntil(input: { postsPerWeek?: unknown; weekdays?: unknown; startDate?: string; endDate: string }): Rhythm {
  if (!input.startDate) throw new RhythmError('endDate needs a startDate');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.endDate) || Number.isNaN(Date.parse(`${input.endDate}T00:00:00Z`)) || new Date(`${input.endDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.endDate) throw new RhythmError('endDate must be a real day like 2026-12-15');
  const span = Math.round((Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`)) / DAY_MS);
  if (span < 0) throw new RhythmError('endDate must not be before startDate');
  if (span > MAX_PLAN_SPAN_DAYS) throw new RhythmError(`endDate must be at most ${MAX_PLAN_SPAN_DAYS + 1} days (four weeks) from startDate`);
  let weekdays: Weekday[];
  if (input.weekdays !== undefined) {
    try {
      weekdays = parseWeekdays(input.weekdays);
    } catch (error) {
      throw new RhythmError(error instanceof Error ? error.message : 'weekdays must be a list like ["mon", "wed"]');
    }
  } else {
    weekdays = [...weekdaysForPostsPerWeek(input.postsPerWeek === undefined ? DEFAULT_POSTS_PER_WEEK : whole(input.postsPerWeek, 'postsPerWeek', 1, 7))];
  }
  // Every matching day from the start to the end (the longest span holds at most 28 days, so the count is always small).
  const inRange = postDates(input.startDate, MAX_PLAN_SPAN_DAYS + 1, WEEKDAYS_ALL).filter((d) => d <= input.endDate && weekdays.includes(weekdayOf(d)));
  if (inRange.length === 0) throw new RhythmError('no post falls between startDate and endDate on those days');
  return { days: Math.min(MAX_POSTS, inRange.length), weekdays };
}

export function weeklyRhythm(input: { weeks?: unknown; postsPerWeek?: unknown; weekdays?: unknown; startDate?: string; endDate?: string }): Rhythm {
  if (input.endDate !== undefined) return rhythmUntil({ postsPerWeek: input.postsPerWeek, weekdays: input.weekdays, ...(input.startDate ? { startDate: input.startDate } : {}), endDate: input.endDate });
  const weeks = input.weeks === undefined ? 1 : whole(input.weeks, 'weeks', 1, MAX_WEEKS);
  // Exact days (a customer's own choice for a channel): a post on each of them every week, so the posts a week are the days chosen. Wins over postsPerWeek.
  if (input.weekdays !== undefined) {
    let chosen: Weekday[];
    try {
      chosen = parseWeekdays(input.weekdays);
    } catch (error) {
      throw new RhythmError(error instanceof Error ? error.message : 'weekdays must be a list like ["mon", "wed"]');
    }
    return { days: Math.min(MAX_POSTS, weeks * chosen.length), weekdays: chosen };
  }
  const perWeek = input.postsPerWeek === undefined ? DEFAULT_POSTS_PER_WEEK : whole(input.postsPerWeek, 'postsPerWeek', 1, 7);
  // A plan that starts on the first day of the usual spread (a Monday for 5 a week: Monday to Friday) keeps that spread. Evenly spacing 5 posts over all seven days from a
  // Monday would give Monday, Tuesday, Wednesday, Friday and Saturday, which is not the plan the owner approved. Any other start day keeps the first post on it.
  const usual = weekdaysForPostsPerWeek(perWeek);
  return { days: Math.min(MAX_POSTS, weeks * perWeek), weekdays: input.startDate && weekdayOf(input.startDate) !== usual[0] ? weekdaysFrom(input.startDate, perWeek) : usual };
}
