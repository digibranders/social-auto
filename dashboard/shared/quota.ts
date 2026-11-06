/**
 * The weekly limit on posters made from a client's website, as the plan forms show it: how many places each channel has in each week that has not passed yet,
 * and a plain sentence when a plan would not fit. The server applies the same rule when the plan is saved (publisher/lib/quota.ts); this copy exists so the
 * owner sees what is free before choosing, never so that the rule is enforced here.
 */
import { PLATFORMS, planDates, platformNames } from './posting-plan.ts';

/** Posters per channel per week unless the client has its own limit. */
export const WEEKLY_LIMIT_DEFAULT = 3;
export const MAX_WEEKLY_LIMIT = 7;
/** How far ahead posters may be planned, counted from today. */
export const HORIZON_DAYS = 31;

/** What the limit needs of a plan, whether it is a saved one or the one being chosen. */
export interface QuotaPlan {
  platforms: readonly string[];
  startDate: string;
  durationDays: number;
  postsPerWeek?: number;
  weekdays?: readonly string[];
}

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const weekStart = (date: string): string => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

const label = (date: string): string => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');

/** "9–15 Nov": the week a Monday starts. */
export function weekLabel(monday: string): string {
  const sunday = addDays(monday, 6);
  const [dayA, monthA] = label(monday).split(' ').slice(1);
  const [dayB, monthB] = label(sunday).split(' ').slice(1);
  return monthA === monthB ? `${dayA}–${dayB} ${monthB}` : `${dayA} ${monthA} – ${dayB} ${monthB}`;
}

/** The posts already planned, per channel and per week (the week's Monday). */
export function usedPerWeek(plans: readonly QuotaPlan[]): Map<string, Map<string, number>> {
  const used = new Map<string, Map<string, number>>();
  for (const plan of plans) {
    for (const day of planDates(plan)) {
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

/** The weeks that can still be planned: the one today is in, up to the one a month ahead ends in. Weeks that have passed are not listed. */
export function openWeeks(today: string): string[] {
  const out: string[] = [];
  for (let week = weekStart(today); week <= addDays(today, HORIZON_DAYS); week = addDays(week, 7)) out.push(week);
  return out;
}

export interface WeekRow {
  monday: string;
  label: string;
  /** For each channel asked about: how many are planned and how many places are free. */
  channels: Record<string, { used: number; free: number }>;
}

/** What is used and free in each open week, for the channels asked about. */
export function availability(existing: readonly QuotaPlan[], channels: readonly string[], limit: number, today: string): WeekRow[] {
  const used = usedPerWeek(existing);
  return openWeeks(today).map((monday) => ({
    monday,
    // The last week may reach past the month ahead; only its days up to then can be planned.
    label: addDays(monday, 6) > addDays(today, HORIZON_DAYS) ? `${weekLabel(monday)} (up to ${label(addDays(today, HORIZON_DAYS)).split(' ').slice(1).join(' ')})` : weekLabel(monday),
    channels: Object.fromEntries(channels.map((c) => {
      const n = used.get(c)?.get(monday) ?? 0;
      return [c, { used: n, free: Math.max(0, limit - n) }];
    })),
  }));
}

/** Why `plan` does not fit next to the client's other plans, in plain words, or null when it fits. The first problem found is the one told. */
export function quotaProblem(existing: readonly QuotaPlan[], plan: QuotaPlan, limit: number, today: string): string | null {
  const days = planDates(plan);
  const last = days.at(-1);
  if (last && last > addDays(today, HORIZON_DAYS)) return `Posters can be planned up to ${HORIZON_DAYS} days ahead, to ${label(addDays(today, HORIZON_DAYS))}. This plan runs to ${label(last)}.`;
  const used = usedPerWeek(existing);
  const adding = new Map<string, number>();
  for (const day of days) adding.set(weekStart(day), (adding.get(weekStart(day)) ?? 0) + 1);
  for (const channel of PLATFORMS.map((p) => p.id).filter((id) => plan.platforms.includes(id))) {
    for (const [week, count] of [...adding].sort(([a], [b]) => a.localeCompare(b))) {
      const already = used.get(channel)?.get(week) ?? 0;
      if (already + count <= limit) continue;
      const name = platformNames([channel]);
      const free = Math.max(0, limit - already);
      return already === 0
        ? `${name} can have ${limit} post${limit === 1 ? '' : 's'} a week, and this plan has ${count} in the week of ${label(week)}.`
        : `${name} already has ${already} post${already === 1 ? '' : 's'} planned in the week of ${label(week)}, so ${free === 0 ? 'no more fit' : `only ${free} more fit${free === 1 ? 's' : ''}`} that week.`;
    }
  }
  return null;
}
