/**
 * Reads numbers from the networks (read only). Each reader says what the network gave and what it refused: a refusal for a missing permission or too few
 * followers is a `need`, not an error, so the rest of the numbers are still kept.
 */
import { instagramGraph } from './instagram.js';
import type { AccountNumbers, AudienceNumbers, Need, PostNumbers } from './analytics.js';

const FACEBOOK_GRAPH = process.env['FACEBOOK_GRAPH_URL'] ?? 'https://graph.facebook.com/v23.0';
const GOOGLE_PERFORMANCE = process.env['GOOGLE_PERFORMANCE_URL'] ?? 'https://businessprofileperformance.googleapis.com/v1';

export class AnalyticsFetchError extends Error {
  constructor(source: string, detail: string) {
    super(`${source} failed: ${detail.slice(0, 300)}`);
    this.name = 'AnalyticsFetchError';
  }
}

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

/** A refusal from Meta because the app was not given a permission (or the account is too small), as opposed to a real failure. */
export interface Refusal {
  permission: boolean;
  followers: boolean;
  /** Meta no longer knows the metric asked for (they retire metrics): the number is simply not available, which is not the customer's doing. */
  retired: boolean;
}

export function refusalOf(body: Json): Refusal | null {
  const error = body['error'];
  if (typeof error !== 'object' || error === null) return null;
  const e = error as Json;
  const code = typeof e['code'] === 'number' ? e['code'] : 0;
  const text = `${String(e['message'] ?? '')} ${String(e['error_user_msg'] ?? '')}`.toLowerCase();
  const followers = /100 followers|not enough followers|minimum of 100/.test(text);
  const permission = code === 10 || (code >= 200 && code <= 299) || /permission|not authorized|requires/.test(text);
  const retired = code === 100 && /valid insights metric|metric.*(not supported|deprecated|no longer)/.test(text);
  return permission || followers || retired ? { permission, followers, retired } : null;
}

export async function graph(fetcher: Fetch, source: string, url: string): Promise<{ body: Json; refusal: Refusal | null }> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
  const body = (await response.json().catch(() => ({}))) as Json;
  if (response.ok && !body['error']) return { body, refusal: null };
  const refusal = refusalOf(body);
  if (refusal) return { body, refusal };
  throw new AnalyticsFetchError(source, JSON.stringify(body['error'] ?? body));
}

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined);

/** A metric's number from Meta's insights answer, whether it comes as a list of values or as one total. */
function insightValue(body: Json, name: string): number | undefined {
  const data = Array.isArray(body['data']) ? (body['data'] as Json[]) : [];
  const item = data.find((d) => d['name'] === name);
  if (!item) return undefined;
  const total = item['total_value'] as Json | undefined;
  if (total && count(total['value']) !== undefined) return count(total['value']);
  const values = Array.isArray(item['values']) ? (item['values'] as Json[]) : [];
  const last = values[values.length - 1];
  return last ? count(last['value']) : undefined;
}

export interface PostReading {
  numbers: PostNumbers;
  caption?: string;
  permalink?: string;
  needs: Need[];
}

export interface AccountReading {
  numbers: Record<string, AccountNumbers>;
  audience?: AudienceNumbers;
  searchTerms?: Array<{ term: string; impressions: number }>;
  needs: Need[];
}

const put = <T extends object>(target: T, key: keyof T, value: number | undefined): void => {
  if (value !== undefined) (target as Record<keyof T, number>)[key] = value;
};

// ---- Instagram ------------------------------------------------------------------------------------------------------------------------------

/** One Instagram post: likes and comments need no new permission; reach, views, shares and saves need the insights permission. */
export async function instagramPost(mediaId: string, token: string, fetcher: Fetch = fetch): Promise<PostReading> {
  const basic = await graph(fetcher, 'Instagram post', `${instagramGraph()}/${mediaId}?${new URLSearchParams({ fields: 'caption,permalink,like_count,comments_count', access_token: token })}`);
  const numbers: PostNumbers = {};
  // A refusal on the basic numbers (no permission to read them) leaves nothing to read: say so, instead of saving an empty reading.
  if (basic.refusal) return { numbers, needs: basic.refusal.permission ? ['reconnect'] : [] };
  put(numbers, 'likes', count(basic.body['like_count']));
  put(numbers, 'comments', count(basic.body['comments_count']));
  const needs: Need[] = [];
  const insights = await graph(fetcher, 'Instagram post insights', `${instagramGraph()}/${mediaId}/insights?${new URLSearchParams({ metric: 'reach,views,shares,saved', access_token: token })}`);
  if (insights.refusal) { if (insights.refusal.permission) needs.push('reconnect'); }
  else {
    put(numbers, 'reach', insightValue(insights.body, 'reach'));
    put(numbers, 'views', insightValue(insights.body, 'views'));
    put(numbers, 'shares', insightValue(insights.body, 'shares'));
    put(numbers, 'saves', insightValue(insights.body, 'saved'));
  }
  return {
    numbers,
    needs,
    ...(typeof basic.body['caption'] === 'string' ? { caption: basic.body['caption'] } : {}),
    ...(typeof basic.body['permalink'] === 'string' ? { permalink: basic.body['permalink'] } : {}),
  };
}

const utcSeconds = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

/** One Instagram account: followers need no new permission; yesterday's reach, views and profile views and the audience need the insights permission. */
export async function instagramAccount(userId: string, token: string, today: string, fetcher: Fetch = fetch): Promise<AccountReading> {
  const needs: Need[] = [];
  const numbers: Record<string, AccountNumbers> = {};
  const profile = await graph(fetcher, 'Instagram account', `${instagramGraph()}/${userId}?${new URLSearchParams({ fields: 'followers_count', access_token: token })}`);
  if (profile.refusal) return { numbers, needs: profile.refusal.permission ? ['reconnect'] : [] };
  const followers = count(profile.body['followers_count']);
  if (followers !== undefined) numbers[today] = { followers };
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const day = await graph(fetcher, 'Instagram account insights', `${instagramGraph()}/${userId}/insights?${new URLSearchParams({ metric: 'reach,views,profile_views', metric_type: 'total_value', period: 'day', since: String(utcSeconds(yesterday)), until: String(utcSeconds(today)), access_token: token })}`);
  if (day.refusal) { if (day.refusal.permission) needs.push('reconnect'); }
  else {
    const entry: AccountNumbers = {};
    put(entry, 'reach', insightValue(day.body, 'reach'));
    put(entry, 'views', insightValue(day.body, 'views'));
    put(entry, 'profileViews', insightValue(day.body, 'profile_views'));
    if (Object.keys(entry).length > 0) numbers[yesterday] = entry;
  }
  const audience: AudienceNumbers = {};
  if (!day.refusal) {
    for (const part of ['age', 'gender', 'country', 'city'] as const) {
      const answer = await graph(fetcher, 'Instagram audience', `${instagramGraph()}/${userId}/insights?${new URLSearchParams({ metric: 'follower_demographics', period: 'lifetime', metric_type: 'total_value', breakdown: part, access_token: token })}`);
      if (answer.refusal) {
        if (answer.refusal.followers) needs.push('followers');
        else if (answer.refusal.permission) needs.push('reconnect');
        break;
      }
      const data = Array.isArray(answer.body['data']) ? (answer.body['data'] as Json[]) : [];
      const total = (data[0]?.['total_value'] ?? {}) as Json;
      const breakdowns = Array.isArray(total['breakdowns']) ? (total['breakdowns'] as Json[]) : [];
      const results = Array.isArray(breakdowns[0]?.['results']) ? (breakdowns[0]?.['results'] as Json[]) : [];
      const parts: Record<string, number> = {};
      for (const r of results) {
        const labels = Array.isArray(r['dimension_values']) ? (r['dimension_values'] as unknown[]).map(String) : [];
        const value = count(r['value']);
        if (labels.length > 0 && value !== undefined) parts[labels.join(' ')] = value;
      }
      if (Object.keys(parts).length > 0) audience[part] = parts;
    }
  }
  return { numbers, needs: [...new Set(needs)], ...(Object.keys(audience).length > 0 ? { audience } : {}) };
}

// ---- Facebook -------------------------------------------------------------------------------------------------------------------------------

/** One Page post: reactions, comments and shares need no new permission; reach and clicks need read_insights. */
export async function facebookPost(postId: string, pageToken: string, fetcher: Fetch = fetch): Promise<PostReading> {
  const basic = await graph(fetcher, 'Facebook post', `${FACEBOOK_GRAPH}/${postId}?${new URLSearchParams({ fields: 'message,permalink_url,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)', access_token: pageToken })}`);
  const numbers: PostNumbers = {};
  if (basic.refusal) return { numbers, needs: basic.refusal.permission ? ['reconnect'] : [] };
  const summary = (key: string): number | undefined => count(((basic.body[key] as Json | undefined)?.['summary'] as Json | undefined)?.['total_count']);
  put(numbers, 'likes', summary('reactions'));
  put(numbers, 'comments', summary('comments'));
  put(numbers, 'shares', count((basic.body['shares'] as Json | undefined)?.['count']));
  const needs: Need[] = [];
  // Meta retired the "impressions" metrics for Pages in favour of "media views"; reach is the unique count of those.
  const insights = await graph(fetcher, 'Facebook post insights', `${FACEBOOK_GRAPH}/${postId}/insights?${new URLSearchParams({ metric: 'post_total_media_view_unique,post_media_view', access_token: pageToken })}`);
  if (insights.refusal) { if (insights.refusal.permission) needs.push('reconnect'); }
  else {
    put(numbers, 'reach', insightValue(insights.body, 'post_total_media_view_unique'));
    put(numbers, 'views', insightValue(insights.body, 'post_media_view'));
  }
  if (!insights.refusal) {
    const clicks = await graph(fetcher, 'Facebook post clicks', `${FACEBOOK_GRAPH}/${postId}/insights?${new URLSearchParams({ metric: 'post_clicks', access_token: pageToken })}`);
    if (!clicks.refusal) put(numbers, 'clicks', insightValue(clicks.body, 'post_clicks'));
  }
  return {
    numbers,
    needs,
    ...(typeof basic.body['message'] === 'string' ? { caption: basic.body['message'] } : {}),
    ...(typeof basic.body['permalink_url'] === 'string' ? { permalink: basic.body['permalink_url'] } : {}),
  };
}

/** One Page: followers need no new permission; the Page's daily reach needs read_insights. */
export async function facebookAccount(pageId: string, pageToken: string, today: string, fetcher: Fetch = fetch): Promise<AccountReading> {
  const needs: Need[] = [];
  const numbers: Record<string, AccountNumbers> = {};
  const profile = await graph(fetcher, 'Facebook page', `${FACEBOOK_GRAPH}/${pageId}?${new URLSearchParams({ fields: 'followers_count', access_token: pageToken })}`);
  if (profile.refusal) return { numbers, needs: profile.refusal.permission ? ['reconnect'] : [] };
  const followers = count(profile.body['followers_count']);
  if (followers !== undefined) numbers[today] = { followers };
  const insights = await graph(fetcher, 'Facebook page insights', `${FACEBOOK_GRAPH}/${pageId}/insights?${new URLSearchParams({ metric: 'page_total_media_view_unique', period: 'day', access_token: pageToken })}`);
  if (insights.refusal) { if (insights.refusal.permission) needs.push('reconnect'); }
  else {
    const data = Array.isArray(insights.body['data']) ? (insights.body['data'] as Json[]) : [];
    const values = Array.isArray(data[0]?.['values']) ? (data[0]?.['values'] as Json[]) : [];
    for (const v of values) {
      const day = typeof v['end_time'] === 'string' ? v['end_time'].slice(0, 10) : '';
      const reach = count(v['value']);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && reach !== undefined) numbers[day] = { ...(numbers[day] ?? {}), reach };
    }
  }
  return { numbers, needs };
}

// ---- Google Business Profile ----------------------------------------------------------------------------------------------------------------

const GOOGLE_METRICS = ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'WEBSITE_CLICKS'] as const;

const datePart = (name: string, day: string): [string, string][] => {
  const [y, m, d] = day.split('-').map(Number);
  return [[`${name}.year`, String(y)], [`${name}.month`, String(m)], [`${name}.day`, String(d)]];
};

async function googleGet(fetcher: Fetch, source: string, url: string, accessToken: string): Promise<Json> {
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new AnalyticsFetchError(source, JSON.stringify(body['error'] ?? body));
  return body;
}

/** A Google location's daily views, calls, direction requests and website clicks for the days from `since` to `until`, and last month's search terms. No numbers per post exist. */
export async function googleLocation(location: string, accessToken: string, since: string, until: string, fetcher: Fetch = fetch): Promise<AccountReading> {
  const params = new URLSearchParams();
  for (const metric of GOOGLE_METRICS) params.append('dailyMetrics', metric);
  for (const [k, v] of [...datePart('dailyRange.start_date', since), ...datePart('dailyRange.end_date', until)]) params.append(k, v);
  const body = await googleGet(fetcher, 'Google performance', `${GOOGLE_PERFORMANCE}/${location}:fetchMultiDailyMetricsTimeSeries?${params}`, accessToken);
  const numbers: Record<string, AccountNumbers> = {};
  const series = Array.isArray(body['multiDailyMetricTimeSeries']) ? (body['multiDailyMetricTimeSeries'] as Json[]) : [];
  for (const group of series) {
    for (const metric of Array.isArray(group['dailyMetricTimeSeries']) ? (group['dailyMetricTimeSeries'] as Json[]) : []) {
      const name = String(metric['dailyMetric']);
      const dated = ((metric['timeSeries'] as Json | undefined)?.['datedValues'] ?? []) as Json[];
      for (const entry of dated) {
        const date = entry['date'] as { year?: number; month?: number; day?: number } | undefined;
        const value = count(entry['value']);
        if (!date?.year || !date.month || !date.day || value === undefined) continue;
        const day = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
        const row: AccountNumbers = numbers[day] ?? {};
        if (name.startsWith('BUSINESS_IMPRESSIONS')) row.views = (row.views ?? 0) + value;
        else if (name === 'CALL_CLICKS') row.calls = value;
        else if (name === 'BUSINESS_DIRECTION_REQUESTS') row.directions = value;
        else if (name === 'WEBSITE_CLICKS') row.websiteClicks = value;
        numbers[day] = row;
      }
    }
  }
  const searchTerms = await googleSearchTerms(location, accessToken, until, fetcher).catch(() => []);
  return { numbers, needs: [], ...(searchTerms.length > 0 ? { searchTerms } : {}) };
}

/** What people searched to find the business in the last full month (Google gives a value, or only "fewer than N"). */
async function googleSearchTerms(location: string, accessToken: string, today: string, fetcher: Fetch): Promise<Array<{ term: string; impressions: number }>> {
  const first = new Date(Date.parse(`${today}T00:00:00Z`));
  const month = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
  const params = new URLSearchParams([['monthlyRange.start_month.year', String(month.getUTCFullYear())], ['monthlyRange.start_month.month', String(month.getUTCMonth() + 1)], ['monthlyRange.end_month.year', String(month.getUTCFullYear())], ['monthlyRange.end_month.month', String(month.getUTCMonth() + 1)]]);
  const body = await googleGet(fetcher, 'Google search terms', `${GOOGLE_PERFORMANCE}/${location}/searchkeywords/impressions/monthly?${params}`, accessToken);
  const rows = Array.isArray(body['searchKeywordsCounts']) ? (body['searchKeywordsCounts'] as Json[]) : [];
  return rows
    .flatMap((r) => {
      const value = r['insightsValue'] as Json | undefined;
      const impressions = count(value?.['value']) ?? count(value?.['threshold']);
      return typeof r['searchKeyword'] === 'string' && impressions !== undefined ? [{ term: r['searchKeyword'], impressions }] : [];
    })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 20);
}
