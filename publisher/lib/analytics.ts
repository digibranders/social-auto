/**
 * Analytics: the numbers the networks give for what we published, kept as a daily time series.
 *
 * A network gives only some numbers (Google none per post, Instagram audience only from 100 followers, and so on). A number a network does not give is
 * left OUT, never written as 0. `needs` records why numbers are missing for an account, so the product can ask the customer to reconnect.
 */

export type AnalyticsPlatform = 'instagram' | 'facebook' | 'google';
export const ANALYTICS_PLATFORMS: readonly AnalyticsPlatform[] = ['instagram', 'facebook', 'google'];

/** Numbers for one post on one day, counted since it went out. */
export interface PostNumbers {
  reach?: number;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
}

/** Numbers for one account on one day. */
export interface AccountNumbers {
  reach?: number;
  views?: number;
  profileViews?: number;
  followers?: number;
  calls?: number;
  directions?: number;
  websiteClicks?: number;
}

/** Why numbers are missing for an account: the customer must connect again to give the new permission, or the account is too small. */
export type Need = 'reconnect' | 'followers';

export interface AudienceNumbers {
  age?: Record<string, number>;
  gender?: Record<string, number>;
  country?: Record<string, number>;
  city?: Record<string, number>;
}

export interface PostSeries {
  brand: string;
  channel: string;
  platform: AnalyticsPlatform;
  permalink: string | null;
  postedAt: string;
  /** Words of the post, cut short: for the hashtag view and for showing the post. */
  caption: string;
  tags: string[];
  /** By UTC day "YYYY-MM-DD". */
  series: Record<string, PostNumbers>;
}

export interface AccountSeries {
  brand: string;
  channel: string;
  platform: AnalyticsPlatform;
  label: string;
  series: Record<string, AccountNumbers>;
  audience?: AudienceNumbers;
  /** Google: what people searched to find the business, last full month. */
  searchTerms?: Array<{ term: string; impressions: number }>;
  needs?: Need[];
  checkedAt: string;
}

export interface AnalyticsFile {
  posts: Record<string, PostSeries>;
  accounts: Record<string, AccountSeries>;
  /** When the last full check finished. */
  checkedAt: string | null;
}

export const EMPTY_ANALYTICS: AnalyticsFile = { posts: {}, accounts: {}, checkedAt: null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
/** Longest a series is kept, per post or account (days of history). */
export const KEEP_DAYS = 400;
export const CAPTION_KEEP = 300;

const POST_KEYS: readonly (keyof PostNumbers)[] = ['reach', 'views', 'likes', 'comments', 'shares', 'saves', 'clicks'];
const ACCOUNT_KEYS: readonly (keyof AccountNumbers)[] = ['reach', 'views', 'profileViews', 'followers', 'calls', 'directions', 'websiteClicks'];

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function keepCounts<T extends object>(raw: unknown, keys: readonly (keyof T)[]): T {
  const out: Record<string, number> = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const key of keys) {
      const value = (raw as Record<string, unknown>)[key as string];
      if (isCount(value)) out[key as string] = Math.round(value);
    }
  }
  return out as T;
}

function parseSeries<T extends object>(raw: unknown, keys: readonly (keyof T)[]): Record<string, T> {
  const out: Record<string, T> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [day, numbers] of Object.entries(raw)) if (DAY.test(day)) out[day] = keepCounts<T>(numbers, keys);
  return out;
}

const isPlatform = (value: unknown): value is AnalyticsPlatform => (ANALYTICS_PLATFORMS as readonly unknown[]).includes(value);

function parseBreakdown(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out = Object.fromEntries(Object.entries(raw).filter(([, v]) => isCount(v)).map(([k, v]) => [k, Math.round(v as number)]));
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Reads the saved file. A malformed entry is a hard error: it is our own file, so a bad one means a bug, not input to be forgiven. */
export function parseAnalytics(raw: unknown): AnalyticsFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('analytics must be an object');
  const file = raw as Record<string, unknown>;
  const posts: Record<string, PostSeries> = {};
  for (const [key, value] of Object.entries((file['posts'] ?? {}) as Record<string, unknown>)) {
    const p = value as Record<string, unknown>;
    if (typeof p !== 'object' || p === null || typeof p['brand'] !== 'string' || typeof p['channel'] !== 'string' || !isPlatform(p['platform']) || typeof p['postedAt'] !== 'string') {
      throw new Error(`analytics.posts["${key}"] is malformed`);
    }
    posts[key] = {
      brand: p['brand'],
      channel: p['channel'],
      platform: p['platform'],
      permalink: typeof p['permalink'] === 'string' ? p['permalink'] : null,
      postedAt: p['postedAt'],
      caption: typeof p['caption'] === 'string' ? p['caption'].slice(0, CAPTION_KEEP) : '',
      tags: Array.isArray(p['tags']) ? p['tags'].filter((t): t is string => typeof t === 'string') : [],
      series: parseSeries<PostNumbers>(p['series'], POST_KEYS),
    };
  }
  const accounts: Record<string, AccountSeries> = {};
  for (const [key, value] of Object.entries((file['accounts'] ?? {}) as Record<string, unknown>)) {
    const a = value as Record<string, unknown>;
    if (typeof a !== 'object' || a === null || typeof a['brand'] !== 'string' || typeof a['channel'] !== 'string' || !isPlatform(a['platform']) || typeof a['label'] !== 'string' || typeof a['checkedAt'] !== 'string') {
      throw new Error(`analytics.accounts["${key}"] is malformed`);
    }
    const audienceRaw = (a['audience'] ?? {}) as Record<string, unknown>;
    const audience: AudienceNumbers = {};
    for (const part of ['age', 'gender', 'country', 'city'] as const) {
      const breakdown = parseBreakdown(audienceRaw[part]);
      if (breakdown) audience[part] = breakdown;
    }
    accounts[key] = {
      brand: a['brand'],
      channel: a['channel'],
      platform: a['platform'],
      label: a['label'],
      series: parseSeries<AccountNumbers>(a['series'], ACCOUNT_KEYS),
      ...(Object.keys(audience).length > 0 ? { audience } : {}),
      ...(Array.isArray(a['searchTerms']) ? { searchTerms: (a['searchTerms'] as Array<Record<string, unknown>>).flatMap((t) => (typeof t['term'] === 'string' && isCount(t['impressions']) ? [{ term: t['term'], impressions: t['impressions'] }] : [])) } : {}),
      ...(Array.isArray(a['needs']) ? { needs: a['needs'].filter((n): n is Need => n === 'reconnect' || n === 'followers') } : {}),
      checkedAt: a['checkedAt'],
    };
  }
  return { posts, accounts, checkedAt: typeof file['checkedAt'] === 'string' ? file['checkedAt'] : null };
}

/** The hashtags of some words, lower case, without the "#", each once. */
export function hashtagsOf(text: string): string[] {
  const found = text.match(/#[\p{L}\p{N}_]{2,60}/gu) ?? [];
  return [...new Set(found.map((tag) => tag.slice(1).toLowerCase()))].slice(0, 30);
}

/** Drops days older than the keep limit. */
function trim<T>(series: Record<string, T>, now: number): Record<string, T> {
  const oldest = dayOf(now - KEEP_DAYS * 86_400_000);
  return Object.fromEntries(Object.entries(series).filter(([day]) => day >= oldest));
}

/** One more day of numbers for a post: a later reading of the same day replaces the earlier one, and a number the network now leaves out is kept from before. */
export function recordPost(file: AnalyticsFile, key: string, base: Omit<PostSeries, 'series'>, day: string, numbers: PostNumbers, now: number): AnalyticsFile {
  const before = file.posts[key];
  const series = trim({ ...(before?.series ?? {}), [day]: { ...(before?.series[day] ?? {}), ...numbers } }, now);
  return { ...file, posts: { ...file.posts, [key]: { ...base, series } } };
}

export function recordAccount(file: AnalyticsFile, key: string, base: Omit<AccountSeries, 'series'>, entries: Record<string, AccountNumbers>, now: number): AnalyticsFile {
  const before = file.accounts[key];
  const merged: Record<string, AccountNumbers> = { ...(before?.series ?? {}) };
  for (const [day, numbers] of Object.entries(entries)) merged[day] = { ...(merged[day] ?? {}), ...numbers };
  return { ...file, accounts: { ...file.accounts, [key]: { ...base, series: trim(merged, now) } } };
}

/** Forgets everything kept for a brand (a customer who left, or a workspace that was removed). */
export function forgetBrand(file: AnalyticsFile, brand: string): AnalyticsFile {
  return {
    ...file,
    posts: Object.fromEntries(Object.entries(file.posts).filter(([, p]) => p.brand !== brand)),
    accounts: Object.fromEntries(Object.entries(file.accounts).filter(([, a]) => a.brand !== brand)),
  };
}

/** Forgets posts and accounts of channels that are no longer connected, so numbers of a removed account are not kept. */
export function keepChannels(file: AnalyticsFile, channelIds: ReadonlySet<string>): AnalyticsFile {
  return {
    ...file,
    posts: Object.fromEntries(Object.entries(file.posts).filter(([, p]) => channelIds.has(p.channel))),
    accounts: Object.fromEntries(Object.entries(file.accounts).filter(([, a]) => channelIds.has(a.channel))),
  };
}

// ---- reading ------------------------------------------------------------------------------------------------------------------------------------

export interface PostView {
  postId: string;
  channel: string;
  platform: AnalyticsPlatform;
  permalink: string | null;
  postedAt: string;
  caption: string;
  /** What the post has so far (its latest day of numbers). */
  total: PostNumbers;
  series: Array<{ date: string } & PostNumbers>;
}

export interface AccountView {
  channel: string;
  platform: AnalyticsPlatform;
  label: string;
  series: Array<{ date: string } & AccountNumbers>;
  audience?: AudienceNumbers;
  searchTerms?: Array<{ term: string; impressions: number }>;
  needs?: Need[];
  checkedAt: string;
}

export interface HashtagView {
  tag: string;
  posts: number;
  avgReach: number;
}

export interface AnalyticsView {
  posts: PostView[];
  accounts: AccountView[];
  hashtags: HashtagView[];
  checkedAt: string | null;
}

/** The latest numbers a post has: for each number, the value on the newest day that has it (totals only grow, so the newest is the total). */
export function totalOf(series: Record<string, PostNumbers>): PostNumbers {
  const total: PostNumbers = {};
  for (const day of Object.keys(series).sort()) Object.assign(total, series[day]);
  return total;
}

const inRange = (day: string, from: string, to: string): boolean => day >= from && day <= to;

/** One brand's numbers between two days (inclusive), newest post first. */
export function viewFor(file: AnalyticsFile, brand: string, from: string, to: string): AnalyticsView {
  const posts: PostView[] = Object.entries(file.posts)
    .filter(([, p]) => p.brand === brand && inRange(p.postedAt.slice(0, 10), from, to))
    .map(([key, p]) => ({
      postId: key.slice(0, key.lastIndexOf('|')),
      channel: p.channel,
      platform: p.platform,
      permalink: p.permalink,
      postedAt: p.postedAt,
      caption: p.caption,
      total: totalOf(p.series),
      series: Object.keys(p.series).sort().map((date) => ({ date, ...p.series[date] })),
    }))
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  const accounts: AccountView[] = Object.values(file.accounts)
    .filter((a) => a.brand === brand)
    .map((a) => ({
      channel: a.channel,
      platform: a.platform,
      label: a.label,
      series: Object.keys(a.series).filter((d) => inRange(d, from, to)).sort().map((date) => ({ date, ...a.series[date] })),
      ...(a.audience ? { audience: a.audience } : {}),
      ...(a.searchTerms ? { searchTerms: a.searchTerms } : {}),
      ...(a.needs && a.needs.length > 0 ? { needs: a.needs } : {}),
      checkedAt: a.checkedAt,
    }));
  return { posts, accounts, hashtags: hashtagViews(file, brand, from, to), checkedAt: file.checkedAt };
}

/** For each hashtag used in the period: how many posts used it and their average reach (posts with no reach number count only towards `posts`). */
export function hashtagViews(file: AnalyticsFile, brand: string, from: string, to: string): HashtagView[] {
  const by = new Map<string, { posts: number; reach: number[] }>();
  for (const p of Object.values(file.posts)) {
    if (p.brand !== brand || !inRange(p.postedAt.slice(0, 10), from, to)) continue;
    const reach = totalOf(p.series).reach;
    for (const tag of p.tags) {
      const entry = by.get(tag) ?? { posts: 0, reach: [] };
      entry.posts += 1;
      if (reach !== undefined) entry.reach.push(reach);
      by.set(tag, entry);
    }
  }
  return [...by.entries()]
    .map(([tag, e]) => ({ tag, posts: e.posts, avgReach: e.reach.length === 0 ? 0 : Math.round(e.reach.reduce((a, b) => a + b, 0) / e.reach.length) }))
    .sort((a, b) => b.avgReach - a.avgReach || b.posts - a.posts || a.tag.localeCompare(b.tag))
    .slice(0, 50);
}

/** Checks a day range from a request: both days are real dates, from is not after to, and the range is at most a year. */
export function parseRange(fromRaw: string | null, toRaw: string | null, now: number): { from: string; to: string } | string {
  const to = toRaw ?? dayOf(now);
  const from = fromRaw ?? dayOf(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000);
  for (const [name, value] of [['from', from], ['to', to]] as const) {
    if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || dayOf(Date.parse(`${value}T00:00:00Z`)) !== value) return `${name} must be a date like 2026-11-30`;
  }
  if (from > to) return 'from must not be after to';
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86_400_000) return 'the range can be at most one year';
  return { from, to };
}
