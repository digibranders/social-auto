import type { AutoPostingData, ChannelHealth, ClientPlanData, CostEntry, PostingDaysData, StatusPost, StatusResponse } from '../shared/status.ts';
import { WEEKLY_LIMIT_DEFAULT } from '../shared/quota.ts';
import { brandLabel, dayKeyOf, formatTime, weekdayName } from './calendar.ts';

export interface ClientSummary {
  brand: string;
  label: string;
  channels: ChannelHealth[];
  /** Days of posts still booked, from the status feed. */
  postsLeft: number;
  /** What is coming up, soonest first. */
  upcoming: StatusPost[];
  /** How often and when, read from the upcoming posts, e.g. "Mon–Fri · 10:00 AM". Null when nothing is booked. */
  pattern: string | null;
  /** Channels with a connection problem. */
  problems: number;
  missed: number;
  /** Seven days or fewer of posts left. */
  queueLow: boolean;
  /** Added in the dashboard: it has no planned posts yet and can be removed. */
  added: boolean;
  /** The product that created this client (e.g. "brandbasket"); null for your own. */
  product: string | null;
  /** The client's website (https address) that posts are planned from; null when none was given. */
  website: string | null;
  /** Everything for this client is held back: the client itself is paused, or everything is. */
  paused: boolean;
  /** What was chosen to post, where and for how long: one entry per plan; empty when nothing was. */
  plans: ClientPlanData[];
  /** The most posters a week the website may make for each channel. */
  weeklyLimit: number;
  /** Every poster made from the website must carry its real logo. */
  requireAuthenticLogo: boolean;
  /** manual: a person approves each poster in Review. auto: posters that pass the automatic checks are approved by the system and released. */
  approvalMode: 'manual' | 'auto';
  /** What the AI may cost for this client in a calendar month, in dollars; null when the client has no limit of its own and the default one applies. */
  spendCapUsd: number | null;
  /** The days of the week each channel posts on, chosen by the customer; a channel with no entry keeps the usual spread. */
  postingDays: PostingDaysData;
  /** Automatic posting, when the customer chose it for some channels; null when every poster waits for her. */
  autoPosting: AutoPostingData | null;
  /** Every post of the client, planned or past; the cost view looks its posts up here. */
  posts: StatusPost[];
  /** What the AI cost for this client, from the content engine's usage log. */
  costs: CostEntry[];
}

/** The monthly AI spend limit every client has until it is given its own (the content engine's default, scheduler/engine/src/paid-ledger.ts). */
export const SPEND_CAP_DEFAULT_USD = 8;

/** What the AI cost for a client so far in the calendar month `now` falls in (UTC, as the content engine counts it), from the feed's cost entries. */
export function spentThisMonth(costs: readonly CostEntry[], now: number): number {
  const month = new Date(now).toISOString().slice(0, 7);
  return Math.round(costs.filter((c) => c.at.slice(0, 7) === month).reduce((total, c) => total + c.usd, 0) * 1e4) / 1e4;
}

const LOW_QUEUE_DAYS = 7;
const PATTERN_LOOKAHEAD_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** "Mon–Fri", "every day", or the days listed, for the weekdays that have a post. */
export function describeDays(days: ReadonlySet<string>): string {
  const ordered = WEEK_ORDER.filter((d) => days.has(d));
  if (ordered.length === 7) return 'every day';
  if (ordered.length === 5 && !days.has('Sat') && !days.has('Sun')) return 'Mon–Fri';
  return ordered.join(', ');
}

/** The pattern of the next two weeks of posts for a client. */
export function schedulePattern(posts: readonly StatusPost[], now: number): string | null {
  const soon = posts.filter((p) => {
    const at = Date.parse(p.date);
    return at > now && at <= now + PATTERN_LOOKAHEAD_DAYS * DAY_MS;
  });
  if (soon.length === 0) return null;
  const days = new Set(soon.map((p) => weekdayName(dayKeyOf(p.date)).slice(0, 3)));
  const times = new Map<string, number>();
  for (const p of soon) times.set(formatTime(p.date), (times.get(formatTime(p.date)) ?? 0) + 1);
  const time = [...times.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return `${describeDays(days)}${time ? ` · ${time}` : ''}`;
}

/** A website address as people read it: without the https://. */
export const websiteHost = (website: string | null): string => (website ?? '').replace(/^https?:\/\//, '');

/** One entry per client, built only from what the status feed already says. */
export function summarizeClients(data: StatusResponse, now: number): ClientSummary[] {
  const brands = [...new Set([...data.runway.map((r) => r.brand), ...data.posts.map((p) => p.brand)])].sort();
  return brands.map((brand) => {
    const posts = data.posts.filter((p) => p.brand === brand);
    const upcoming = posts.filter((p) => Date.parse(p.date) > now).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const channels = data.channels.filter((c) => c.brands.includes(brand));
    const entry = data.runway.find((r) => r.brand === brand);
    const postsLeft = entry?.postsLeft ?? 0;
    const added = entry?.added === true;
    return {
      brand,
      label: entry?.name ?? brandLabel(brand),
      channels,
      postsLeft,
      upcoming,
      pattern: schedulePattern(posts.filter((p) => !p.manual), now),
      problems: channels.filter((c) => !c.ok).length,
      missed: posts.filter((p) => p.state === 'missed').length,
      queueLow: !added && postsLeft <= LOW_QUEUE_DAYS,
      added,
      product: entry?.product ?? null,
      website: entry?.website ?? null,
      paused: data.pauses.all || data.pauses.brands.includes(brand),
      plans: entry?.plans ?? [],
      weeklyLimit: entry?.weeklyLimit ?? WEEKLY_LIMIT_DEFAULT,
      requireAuthenticLogo: entry?.requireAuthenticLogo === true,
      approvalMode: entry?.approvalMode === 'auto' ? 'auto' : 'manual',
      spendCapUsd: entry?.spendCapUsd ?? null,
      postingDays: entry?.postingDays ?? {},
      autoPosting: entry?.autoPosting ?? null,
      posts,
      costs: data.costs.filter((c) => c.brand === brand),
    };
  });
}

/** What choosing automatic approval means, said wherever the choice is offered. */
export const AUTO_WARNING = 'Automatic: posters that pass the automatic checks are approved by the system and posted on their day. Nobody approves them in the Review tab, so you do not see a poster before it goes out. Failed checks, limits and the pause switch still stop a post.';
