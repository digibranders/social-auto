/** What the publisher's /api/analytics answers, read strictly, and the sums the dashboard shows. */

export type AnalyticsPlatform = 'instagram' | 'facebook' | 'google';
const PLATFORMS: readonly AnalyticsPlatform[] = ['instagram', 'facebook', 'google'];

export interface Numbers {
  reach?: number;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  clicks?: number;
}

export interface AccountDay {
  date: string;
  reach?: number;
  views?: number;
  profileViews?: number;
  followers?: number;
  calls?: number;
  directions?: number;
  websiteClicks?: number;
}

export interface AnalyticsPost {
  postId: string;
  channel: string;
  platform: AnalyticsPlatform;
  permalink: string | null;
  postedAt: string;
  caption: string;
  total: Numbers;
}

export interface AnalyticsAccount {
  channel: string;
  platform: AnalyticsPlatform;
  label: string;
  series: AccountDay[];
  audience?: { age?: Record<string, number>; gender?: Record<string, number>; country?: Record<string, number>; city?: Record<string, number> };
  searchTerms?: Array<{ term: string; impressions: number }>;
  needs?: Array<'reconnect' | 'followers'>;
  checkedAt: string;
}

export interface AnalyticsData {
  enabled: boolean;
  posts: AnalyticsPost[];
  accounts: AnalyticsAccount[];
  hashtags: Array<{ tag: string; posts: number; avgReach: number }>;
  checkedAt: string | null;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const object = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function counts<T extends object>(raw: unknown, keys: readonly string[]): T {
  const source = object(raw);
  return Object.fromEntries(keys.filter((k) => isCount(source[k])).map((k) => [k, source[k]])) as T;
}

function breakdown(raw: unknown): Record<string, number> | undefined {
  const entries = Object.entries(object(raw)).filter(([, v]) => isCount(v)) as Array<[string, number]>;
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const platformOf = (v: unknown): AnalyticsPlatform | null => PLATFORMS.find((p) => p === v) ?? null;

/** A part that cannot be read is left out so the rest still shows; only a wrong shape as a whole is refused. */
export function parseAnalytics(raw: unknown): AnalyticsData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('The analytics answer is not an object');
  const body = raw as Record<string, unknown>;
  const posts = list(body['posts']).flatMap((p): AnalyticsPost[] => {
    const o = object(p);
    const platform = platformOf(o['platform']);
    if (!platform || typeof o['postId'] !== 'string' || typeof o['channel'] !== 'string' || typeof o['postedAt'] !== 'string') return [];
    return [{ postId: o['postId'], channel: o['channel'], platform, permalink: typeof o['permalink'] === 'string' ? o['permalink'] : null, postedAt: o['postedAt'], caption: typeof o['caption'] === 'string' ? o['caption'] : '', total: counts<Numbers>(o['total'], ['reach', 'views', 'likes', 'comments', 'shares', 'saves', 'clicks']) }];
  });
  const accounts = list(body['accounts']).flatMap((a): AnalyticsAccount[] => {
    const o = object(a);
    const platform = platformOf(o['platform']);
    if (!platform || typeof o['channel'] !== 'string' || typeof o['label'] !== 'string') return [];
    const audienceRaw = object(o['audience']);
    const audience = Object.fromEntries((['age', 'gender', 'country', 'city'] as const).flatMap((k) => { const b = breakdown(audienceRaw[k]); return b ? [[k, b]] : []; }));
    const terms = list(o['searchTerms']).flatMap((t) => { const x = object(t); return typeof x['term'] === 'string' && isCount(x['impressions']) ? [{ term: x['term'], impressions: x['impressions'] }] : []; });
    const needs = list(o['needs']).filter((n): n is 'reconnect' | 'followers' => n === 'reconnect' || n === 'followers');
    return [{
      channel: o['channel'],
      platform,
      label: o['label'],
      series: list(o['series']).flatMap((d): AccountDay[] => { const x = object(d); return typeof x['date'] === 'string' ? [{ date: x['date'], ...counts<Omit<AccountDay, 'date'>>(x, ['reach', 'views', 'profileViews', 'followers', 'calls', 'directions', 'websiteClicks']) }] : []; }),
      ...(Object.keys(audience).length > 0 ? { audience } : {}),
      ...(terms.length > 0 ? { searchTerms: terms } : {}),
      ...(needs.length > 0 ? { needs } : {}),
      checkedAt: typeof o['checkedAt'] === 'string' ? o['checkedAt'] : '',
    }];
  });
  const hashtags = list(body['hashtags']).flatMap((t) => { const x = object(t); return typeof x['tag'] === 'string' && isCount(x['posts']) && isCount(x['avgReach']) ? [{ tag: x['tag'], posts: x['posts'], avgReach: x['avgReach'] }] : []; });
  return { enabled: body['enabled'] === true, posts, accounts, hashtags, checkedAt: typeof body['checkedAt'] === 'string' ? body['checkedAt'] : null };
}

/** The sum of one daily number over all days of the chosen accounts; undefined when none of them ever gave it (so the screen shows "not given", not 0). */
export function sumAccounts(accounts: readonly AnalyticsAccount[], key: Exclude<keyof AccountDay, 'date'>): number | undefined {
  let found = false;
  let total = 0;
  for (const account of accounts) {
    for (const day of account.series) {
      const value = day[key];
      if (value !== undefined) {
        found = true;
        total += value;
      }
    }
  }
  return found ? total : undefined;
}

/** The newest follower count of each account, added up. */
export function followersNow(accounts: readonly AnalyticsAccount[]): number | undefined {
  let found = false;
  let total = 0;
  for (const account of accounts) {
    const days = account.series.filter((d) => d.followers !== undefined).sort((a, b) => a.date.localeCompare(b.date));
    const last = days[days.length - 1]?.followers;
    if (last !== undefined) {
      found = true;
      total += last;
    }
  }
  return found ? total : undefined;
}

/** One number per day over all chosen accounts, oldest first, for the chart. */
export function dailySeries(accounts: readonly AnalyticsAccount[], key: Exclude<keyof AccountDay, 'date'>): Array<{ date: string; value: number }> {
  const by = new Map<string, number>();
  for (const account of accounts) for (const day of account.series) if (day[key] !== undefined) by.set(day.date, (by.get(day.date) ?? 0) + (day[key] as number));
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

export const formatCount = (value: number | undefined): string => (value === undefined ? 'Not given' : value.toLocaleString('en-US'));
