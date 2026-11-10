/**
 * How often a client posts when the owner does not say otherwise: two posts per channel per week, on days spread through the week. A post goes to every channel
 * the owner approves it for, so the posts of a week are the posts of each of its channels; "weeks" says how many weeks are written at once.
 */
import { weekdaysForPostsPerWeek, type Weekday } from './cadence.ts';

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

/** The posts to write for a number of weeks at a number of posts a week (two a week for one week when neither is given). */
export function weeklyRhythm(input: { weeks?: unknown; postsPerWeek?: unknown }): Rhythm {
  const weeks = input.weeks === undefined ? 1 : whole(input.weeks, 'weeks', 1, MAX_WEEKS);
  const perWeek = input.postsPerWeek === undefined ? DEFAULT_POSTS_PER_WEEK : whole(input.postsPerWeek, 'postsPerWeek', 1, 7);
  return { days: Math.min(MAX_POSTS, weeks * perWeek), weekdays: weekdaysForPostsPerWeek(perWeek) };
}
