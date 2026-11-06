/**
 * What the owner chooses when a client's website is added: which platforms to post on, on which days, and for how long. The form shows the exact days,
 * how many posters that means and roughly what they cost before anything is saved, and sends the plan to the server, which checks it again.
 * "Just one day" is a single day (tomorrow by default); "3 a week for a month" is a window of 31 days with Monday, Wednesday and Friday.
 */
export const PLATFORMS = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'google', label: 'Google Business' },
] as const;
export type PlanPlatform = (typeof PLATFORMS)[number]['id'];

/**
 * The platforms a client really has an account of its own connected on. The team's one shared Instagram account (it has no channel id) does not count:
 * posters made from a plan are never sent through it, so choosing Instagram for a client with no Instagram of its own would send them nowhere.
 */
export function connectedPlatforms(channels: ReadonlyArray<{ platform: string; id: string | null }>): PlanPlatform[] {
  return PLATFORMS.map((p) => p.id).filter((id) => channels.some((c) => c.platform === id && c.id !== null));
}

export const DURATIONS = [
  { id: 'day', label: 'Just one day', days: 1 },
  { id: 'week', label: '1 week', days: 7 },
  { id: 'two-weeks', label: '2 weeks', days: 14 },
  { id: 'month', label: '1 month', days: 31 },
] as const;
export type DurationId = (typeof DURATIONS)[number]['id'];

export const MAX_PLAN_DAYS = 31;
/** Rough dollars for one poster, low and high; shown only so the owner knows what to expect. */
export const POSTER_COST = { low: 0.02, high: 0.06 } as const;

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** "N a week" spread as evenly through the week as whole days allow (the same table the content engine uses). */
const EVEN_SPREAD: Record<number, readonly (typeof WEEKDAYS)[number][]> = {
  1: ['mon'], 2: ['mon', 'thu'], 3: ['mon', 'wed', 'fri'], 4: ['mon', 'tue', 'thu', 'fri'], 5: ['mon', 'tue', 'wed', 'thu', 'fri'], 6: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], 7: WEEKDAYS,
};

export interface PlanInput {
  platforms: PlanPlatform[];
  startDate: string;
  durationDays: number;
  /** 1 to 7, or undefined for every day. Ignored for a single day. */
  postsPerWeek?: number;
  time: string;
  utcOffset: string;
}

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (date: string): (typeof WEEKDAYS)[number] => WEEKDAYS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] as (typeof WEEKDAYS)[number];

/** Today's date at a UTC offset like "+05:30". */
export function todayAt(utcOffset: string, now: Date = new Date()): string {
  const sign = utcOffset.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = utcOffset.slice(1).split(':').map(Number);
  return new Date(now.getTime() + sign * (h * 60 + m) * 60_000).toISOString().slice(0, 10);
}
export const tomorrowAt = (utcOffset: string, now: Date = new Date()): string => addDays(todayAt(utcOffset, now), 1);

/** The days the plan posts on. A single day is that day whatever its weekday; otherwise every day of the window that fits the pattern. */
export function planDates(plan: Pick<PlanInput, 'startDate' | 'durationDays' | 'postsPerWeek'> & { weekdays?: readonly string[] }): string[] {
  if (plan.durationDays <= 1) return [plan.startDate];
  const pattern = plan.weekdays ? new Set<string>(plan.weekdays) : plan.postsPerWeek ? new Set<string>(EVEN_SPREAD[plan.postsPerWeek] ?? []) : null;
  const out: string[] = [];
  for (let i = 0; i < plan.durationDays; i++) {
    const day = addDays(plan.startDate, i);
    if (!pattern || pattern.has(weekdayOf(day))) out.push(day);
  }
  return out;
}

export function planCost(count: number): { low: number; high: number } {
  return { low: Math.round(count * POSTER_COST.low * 100) / 100, high: Math.round((count * POSTER_COST.high + 0.02) * 100) / 100 };
}

/** "Fri 6 Nov", read in English whatever the browser's language. */
export function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '');
}

export function platformNames(platforms: readonly string[]): string {
  const names = PLATFORMS.filter((p) => platforms.includes(p.id)).map((p) => p.label);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

/** The time of day now at a UTC offset like "+05:30", as HH:MM. */
export function nowTimeAt(utcOffset: string, now: Date = new Date()): string {
  const sign = utcOffset.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = utcOffset.slice(1).split(':').map(Number);
  return new Date(now.getTime() + sign * (h * 60 + m) * 60_000).toISOString().slice(11, 16);
}

/** A problem with the choices made so far, in plain words, or null when they make a plan. */
export function planProblem(input: Pick<PlanInput, 'platforms' | 'startDate' | 'durationDays'> & { time?: string }, now: Date = new Date(), utcOffset = '+05:30'): string | null {
  if (input.platforms.length === 0) return 'Choose at least one platform.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || new Date(`${input.startDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.startDate) return 'Choose the day to start.';
  if (input.startDate < todayAt(utcOffset, now)) return 'The start day has already passed.';
  if (input.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) return 'Choose the time of day to post.';
  if (input.time !== undefined && input.startDate === todayAt(utcOffset, now) && input.time <= nowTimeAt(utcOffset, now)) return 'That time has already passed today. Choose a later time, or start tomorrow.';
  if (input.durationDays < 1 || input.durationDays > MAX_PLAN_DAYS) return `Choose from 1 to ${MAX_PLAN_DAYS} days.`;
  return null;
}

/** What the server is sent: only what is needed, and a pattern only when it means something. */
export function planPayload(input: PlanInput): Record<string, unknown> {
  return {
    platforms: PLATFORMS.map((p) => p.id).filter((id) => input.platforms.includes(id)),
    startDate: input.startDate,
    durationDays: input.durationDays,
    ...(input.durationDays > 1 && input.postsPerWeek ? { postsPerWeek: input.postsPerWeek } : {}),
    time: input.time,
    utcOffset: input.utcOffset,
  };
}

/** One sentence for the form and the client's page: "3 posts on Instagram and Facebook: Fri 6 Nov, Mon 9 Nov, Wed 11 Nov". */
export function planSentence(plan: { platforms: readonly string[]; startDate: string; durationDays: number; postsPerWeek?: number; weekdays?: readonly string[] }): string {
  const dates = planDates({ startDate: plan.startDate, durationDays: plan.durationDays, ...(plan.postsPerWeek ? { postsPerWeek: plan.postsPerWeek } : {}) });
  const shown = dates.length > 4 ? `${dayLabel(dates[0] as string)} to ${dayLabel(dates.at(-1) as string)}` : dates.map(dayLabel).join(', ');
  return `${dates.length} post${dates.length === 1 ? '' : 's'} on ${platformNames(plan.platforms)}: ${shown}`;
}
