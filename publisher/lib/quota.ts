/**
 * How many posters may be made from a client's website: a weekly limit for each channel, counted over the weeks that have not passed yet and at most a month
 * ahead. Every plan of the client counts, and a plan that posts on two channels uses a place on both. A week that has passed is closed: what was not used in it
 * is gone, not carried over. Posts written by hand are not counted, because the limit is about what the website's posters cost.
 * Dates are plain YYYY-MM-DD days in the plan's own time zone, so nothing here depends on the server's clock zone.
 */
import { EditError } from './overrides.js';
import type { ClientPlan } from './clients.js';

/** Posts per channel per week unless the client has its own limit. */
export const DEFAULT_WEEKLY_LIMIT = 3;
export const MAX_WEEKLY_LIMIT = 7;
/** How far ahead posters may be planned, counted from today. */
export const HORIZON_DAYS = 31;

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** "N a week" spread as evenly through the week as whole days allow (the same table the content engine and the dashboard use). */
const EVEN_SPREAD: Record<number, readonly (typeof WEEKDAYS)[number][]> = {
  1: ['mon'], 2: ['mon', 'thu'], 3: ['mon', 'wed', 'fri'], 4: ['mon', 'tue', 'thu', 'fri'], 5: ['mon', 'tue', 'wed', 'thu', 'fri'], 6: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], 7: WEEKDAYS,
};

export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (date: string): (typeof WEEKDAYS)[number] => WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] as (typeof WEEKDAYS)[number];

/** The Monday of the week a day is in. */
export const weekStart = (date: string): string => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/** Today's date at a UTC offset like "+05:30". */
export function todayAt(utcOffset: string, now: number): string {
  const sign = utcOffset.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = utcOffset.slice(1).split(':').map(Number);
  return new Date(now + sign * (h * 60 + m) * 60_000).toISOString().slice(0, 10);
}

/** The days a plan posts on: a single day whatever its weekday, otherwise the days of the window that fit its weekdays or its "N a week" pattern. */
export function planDays(plan: Pick<ClientPlan, 'startDate' | 'durationDays' | 'postsPerWeek' | 'weekdays'>): string[] {
  if (plan.durationDays <= 1) return [plan.startDate];
  const pattern = plan.weekdays ? new Set<string>(plan.weekdays) : plan.postsPerWeek ? new Set<string>(EVEN_SPREAD[plan.postsPerWeek] ?? []) : null;
  const out: string[] = [];
  for (let i = 0; i < plan.durationDays; i += 1) {
    const day = addDays(plan.startDate, i);
    if (!pattern || pattern.has(weekdayOf(day))) out.push(day);
  }
  return out;
}

/** "Mon 9 Nov", read in English whatever the server's language. */
export function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
}

const CHANNEL_NAMES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', google: 'Google Business' };

/** The posts already planned, per channel and per week (the week's Monday). */
export function usedPerWeek(plans: readonly ClientPlan[]): Map<string, Map<string, number>> {
  const used = new Map<string, Map<string, number>>();
  for (const plan of plans) {
    for (const day of planDays(plan)) {
      const week = weekStart(day);
      for (const channel of plan.platforms) {
        const weeks = used.get(channel) ?? new Map<string, number>();
        weeks.set(week, (weeks.get(week) ?? 0) + 1);
        used.set(channel, weeks);
      }
    }
  }
  return used;
}

/**
 * Throws, in plain words, when adding `plan` to the client's `existing` plans would go over its weekly limit on any channel, or reach further than a month
 * ahead. The first problem found is the one told.
 */
export function assertWithinLimit(existing: readonly ClientPlan[], plan: ClientPlan, limit: number, now: number): void {
  const today = todayAt(plan.utcOffset, now);
  const days = planDays(plan);
  const last = days.at(-1) as string;
  if (last > addDays(today, HORIZON_DAYS)) throw new EditError(`posters can be planned up to ${HORIZON_DAYS} days ahead, to ${dayLabel(addDays(today, HORIZON_DAYS))}; this plan runs to ${dayLabel(last)}`);
  const used = usedPerWeek(existing);
  const adding = new Map<string, number>();
  for (const day of days) adding.set(weekStart(day), (adding.get(weekStart(day)) ?? 0) + 1);
  for (const channel of plan.platforms) {
    for (const [week, count] of [...adding].sort(([a], [b]) => a.localeCompare(b))) {
      const already = used.get(channel)?.get(week) ?? 0;
      if (already + count <= limit) continue;
      const name = CHANNEL_NAMES[channel] ?? channel;
      const free = Math.max(0, limit - already);
      throw new EditError(
        already === 0
          ? `${name} can have ${limit} post${limit === 1 ? '' : 's'} a week, and this plan has ${count} in the week of ${dayLabel(week)}`
          : `${name} already has ${already} post${already === 1 ? '' : 's'} planned in the week of ${dayLabel(week)}, so ${free === 0 ? 'no more fit' : `only ${free} more fit${free === 1 ? 's' : ''}`} that week (the limit is ${limit} a week)`,
      );
    }
  }
}
