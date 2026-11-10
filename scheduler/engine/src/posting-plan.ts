/**
 * What the owner chooses in the dashboard when a client's website is added: which platforms to post on, on which days, and for how long.
 * "Tomorrow only" is a single day; "three times a week for a month" is a window of 31 days with Monday, Wednesday and Friday. The plan is plain data,
 * and everything derived from it (the exact dates, how many posters to make, what the run will cost at most, the autopilot's arguments) is computed
 * here, in code, so the form, the runner and the tests all agree. Nothing here talks to a platform: a plan only says what is wanted.
 */
import { createHash } from 'node:crypto';
import { parseWeekdays, weekdayOf, weekdaysForPostsPerWeek, type Weekday } from './cadence.ts';

export const PLAN_PLATFORMS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
export type PlanPlatform = (typeof PLAN_PLATFORMS)[number];

/** The longest a plan may run, which is also the most posters one plan may ask for (one post a day at most). */
export const MAX_PLAN_DAYS = 31;
/** Posters made in one run: a long plan is made in several runs, each within its own spending limits. */
export const POSTERS_PER_RUN = 8;
/** Rough dollars for one poster, low and high, with its writing, review and one possible retry; used only to show the owner what to expect. */
export const POSTER_COST_USD = { low: 0.02, high: 0.06 } as const;

export interface PostingPlan {
  platforms: PlanPlatform[];
  /** The exact connected account each platform posts to ("linkedin:<member id>"), one per platform; missing means the client's only account on a platform. */
  channelIds?: string[];
  /** The first day that may be posted on, YYYY-MM-DD. */
  startDate: string;
  /** How many days the plan covers, from the start date: 1 is a single day. */
  durationDays: number;
  /** "N a week" (1 to 7), spread through the week. Ignored for a single day. */
  postsPerWeek?: number;
  /** Exact weekdays; wins over postsPerWeek. Ignored for a single day. */
  weekdays?: Weekday[];
  /** HH:MM local time of the post, and its UTC offset. */
  time: string;
  utcOffset: string;
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDate = (date: string): boolean => DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Today's date at a UTC offset like "+05:30". */
export function todayAt(utcOffset: string, now: Date = new Date()): string {
  const sign = utcOffset.startsWith('-') ? -1 : 1;
  const [h = 0, m = 0] = utcOffset.slice(1).split(':').map(Number);
  return new Date(now.getTime() + sign * (h * 60 + m) * 60_000).toISOString().slice(0, 10);
}

/** Tomorrow's date at an offset, the default start of a plan. */
export const tomorrowAt = (utcOffset: string, now: Date = new Date()): string => addDays(todayAt(utcOffset, now), 1);

/** Reads a plan from untrusted data and refuses anything that is not a complete, sensible plan. */
export function parsePostingPlan(raw: unknown, options: { now?: Date } = {}): PostingPlan {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new PlanError('the posting plan must be an object');
  const r = raw as Record<string, unknown>;
  const platforms = r['platforms'];
  if (!Array.isArray(platforms) || platforms.length === 0) throw new PlanError('choose at least one platform to post on');
  const chosen = new Set<PlanPlatform>();
  for (const p of platforms) {
    if (typeof p !== 'string' || !(PLAN_PLATFORMS as readonly string[]).includes(p)) throw new PlanError(`"${String(p)}" is not a platform (use ${PLAN_PLATFORMS.join(', ')})`);
    chosen.add(p as PlanPlatform);
  }
  const time = typeof r['time'] === 'string' ? r['time'] : '10:00';
  const utcOffset = typeof r['utcOffset'] === 'string' ? r['utcOffset'] : '+05:30';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new PlanError('the time must be HH:MM');
  if (!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(utcOffset)) throw new PlanError('the UTC offset must look like +05:30');
  const startDate = r['startDate'];
  if (typeof startDate !== 'string' || !isRealDate(startDate)) throw new PlanError('the start date must be a real date, YYYY-MM-DD');
  if (startDate < todayAt(utcOffset, options.now)) throw new PlanError('the start date is in the past');
  const durationDays = r['durationDays'];
  if (typeof durationDays !== 'number' || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_PLAN_DAYS) throw new PlanError(`the length must be a whole number of days from 1 to ${MAX_PLAN_DAYS}`);
  const plan: PostingPlan = { platforms: PLAN_PLATFORMS.filter((p) => chosen.has(p)), startDate, durationDays, time, utcOffset };
  if (r['channelIds'] !== undefined) {
    const ids = r['channelIds'];
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > PLAN_PLATFORMS.length) throw new PlanError('the accounts to post to must be a short list of account ids');
    const byPlatform = new Map<string, string>();
    for (const id of ids) {
      if (typeof id !== 'string' || !/^(facebook|linkedin|google|instagram):[A-Za-z0-9_.:@-]{1,120}$/.test(id)) throw new PlanError('one of the accounts to post to is not a valid account id');
      const platform = id.slice(0, id.indexOf(':'));
      if (!chosen.has(platform as PlanPlatform)) throw new PlanError(`the account ${id} is for ${platform}, which is not one of this plan's platforms`);
      if (byPlatform.has(platform)) throw new PlanError(`choose one account for ${platform}, not two`);
      byPlatform.set(platform, id);
    }
    plan.channelIds = PLAN_PLATFORMS.flatMap((p) => (byPlatform.has(p) ? [byPlatform.get(p) as string] : []));
  }
  if (r['weekdays'] !== undefined) {
    try {
      plan.weekdays = parseWeekdays(r['weekdays']);
    } catch (error) {
      throw new PlanError(error instanceof Error ? error.message : 'the weekdays are not valid');
    }
  } else if (r['postsPerWeek'] !== undefined) {
    const n = r['postsPerWeek'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 7) throw new PlanError('posts per week must be a whole number from 1 to 7');
    plan.postsPerWeek = n;
  }
  return plan;
}

/** The days the plan posts on, in order. A single day is that day whatever its weekday; otherwise every day of the window that matches the pattern. */
export function planDates(plan: PostingPlan): string[] {
  if (plan.durationDays === 1) return [plan.startDate];
  const pattern = plan.weekdays ? new Set<Weekday>(plan.weekdays) : plan.postsPerWeek ? new Set<Weekday>(weekdaysForPostsPerWeek(plan.postsPerWeek)) : null;
  const out: string[] = [];
  for (let i = 0; i < plan.durationDays; i++) {
    const day = addDays(plan.startDate, i);
    if (!pattern || pattern.has(weekdayOf(day))) out.push(day);
  }
  return out;
}

export const planPostCount = (plan: PostingPlan): number => planDates(plan).length;

/** What to expect, in dollars, for the whole plan. Shown before anything starts; the spending limits are what actually protect the owner. */
export function planCost(plan: PostingPlan): { low: number; high: number } {
  const n = planPostCount(plan);
  return { low: Math.round(n * POSTER_COST_USD.low * 100) / 100, high: Math.round((n * POSTER_COST_USD.high + 0.02) * 100) / 100 };
}

/** A short, stable id of a plan for one website: the same plan for the same site is the same campaign, so it is never started twice. */
export function planId(site: string, plan: PostingPlan): string {
  const canonical = JSON.stringify({ site: site.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, ''), plan: { ...plan, platforms: [...plan.platforms].sort() } });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export interface PlanBatch {
  index: number;
  dates: string[];
}

/** The plan's dates in runs of at most POSTERS_PER_RUN, so a month is made in a few runs, each within its own spending limits. */
export function planBatches(plan: PostingPlan, size: number = POSTERS_PER_RUN): PlanBatch[] {
  const dates = planDates(plan);
  const out: PlanBatch[] = [];
  for (let i = 0; i < dates.length; i += size) out.push({ index: out.length, dates: dates.slice(i, i + size) });
  return out;
}

/** The autopilot's arguments for one batch of the plan: it writes exactly these days, as AI posters into the review queue, and schedules nothing. */
export function autopilotArgsFor(plan: PostingPlan, site: string, batch: PlanBatch, options: { requireAuthenticLogo?: boolean; monthCapUsd?: number } = {}): string[] {
  const first = batch.dates[0] as string;
  const args = ['src/autopilot.ts', '--site', site, '--route', 'ai', '--days', String(batch.dates.length), '--start', first, '--time', plan.time, '--utc-offset', plan.utcOffset,
    // The autopilot wants a destination before it looks at the route. The AI route never schedules or exports on its own: it queues each poster for the owner's review and stops.
    '--target', 'publisher'];
  // A client that requires the website's real logo is stopped before anything is bought when it cannot be had.
  if (options.requireAuthenticLogo) args.push('--require-logo');
  // The client's own monthly spend limit, when the owner gave one; otherwise the engine's default applies.
  if (options.monthCapUsd !== undefined) args.push('--month-cap-usd', String(options.monthCapUsd));
  // The pattern is needed only when the batch is not simply consecutive days: the autopilot then picks the first N matching days from the start.
  const consecutive = batch.dates.every((d, i) => d === addDays(first, i));
  if (!consecutive) args.push('--weekdays', [...new Set(batch.dates.map(weekdayOf))].join(','));
  return args;
}

/** A plain-language line for the dashboard: "3 posts: Mon 9 Nov, Wed 11 Nov, Fri 13 Nov on Instagram and Facebook". */
export function planSummary(plan: PostingPlan): string {
  const dates = planDates(plan);
  const names: Record<PlanPlatform, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', google: 'Google Business' };
  const where = plan.platforms.map((p) => names[p]);
  const list = where.length > 1 ? `${where.slice(0, -1).join(', ')} and ${where.at(-1)}` : (where[0] ?? '');
  return `${dates.length} post${dates.length === 1 ? '' : 's'} on ${list}, ${dates.length === 1 ? dates[0] : `${dates[0]} to ${dates.at(-1)}`}`;
}
