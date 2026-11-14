import { weekdayOf } from './cadence.ts';
import { mondayOf } from './picture-limit.ts';
import { scheduleDates, type PlanSchedule } from './planner.ts';

/**
 * Splits what a batch is asked to write into one schedule per calendar week (Monday to Sunday), in order, so the writer can write and save one week at a time. The days are exactly
 * the days the whole schedule has: writing each chunk's schedule gives back that chunk's days. A schedule inside one week is one chunk, the schedule itself.
 */
export function weekChunks(schedule: PlanSchedule): PlanSchedule[] {
  const days = scheduleDates(schedule).map((d) => d.slice(0, 10));
  const byWeek = new Map<string, string[]>();
  for (const day of days) byWeek.set(mondayOf(day), [...(byWeek.get(mondayOf(day)) ?? []), day]);
  if (byWeek.size <= 1) return [schedule];
  return [...byWeek.values()].map((week) => ({
    ...schedule,
    startDate: week[0] as string,
    count: week.length,
    ...(schedule.weekdays ? { weekdays: [...new Set(week.map(weekdayOf))] } : {}),
  }));
}
