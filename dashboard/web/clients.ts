import type { ChannelHealth, StatusPost, StatusResponse } from '../shared/status.ts';
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
    };
  });
}
