import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facebookAccount, facebookPost, googleLocation, instagramAccount, instagramPost } from './analytics-fetch.ts';

type Route = [match: RegExp, status: number, body: unknown];
function fakeFetch(routes: Route[], seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url.replace(/access_token=[^&]+/, 'access_token=X'));
    const route = routes.find(([match]) => match.test(url));
    return new Response(JSON.stringify(route ? route[2] : { error: { message: `no route for ${url}` } }), { status: route ? route[1] : 500 });
  }) as typeof fetch;
}
const refusal = { error: { code: 10, message: '(#10) Application does not have permission for this action' } };

test('an Instagram post gives likes and comments with no new permission, and says "reconnect" when the insights permission is missing', async () => {
  const f = fakeFetch([[/\/m1\/insights/, 400, refusal], [/\/m1\?/, 200, { caption: 'Hi #diwali', permalink: 'https://ig/p/1', like_count: 12, comments_count: 3 }]]);
  const reading = await instagramPost('m1', 'tok', f);
  assert.deepEqual(reading.numbers, { likes: 12, comments: 3 });
  assert.deepEqual(reading.needs, ['reconnect']);
  assert.equal(reading.caption, 'Hi #diwali');
});

test('an Instagram post with the permission gives reach, views, shares and saves, and a number Meta leaves out is absent', async () => {
  const f = fakeFetch([[/\/m1\/insights/, 200, { data: [{ name: 'reach', values: [{ value: 90 }] }, { name: 'views', values: [{ value: 140 }] }, { name: 'saved', values: [{ value: 5 }] }] }], [/\/m1\?/, 200, { like_count: 1, comments_count: 0 }]]);
  const reading = await instagramPost('m1', 'tok', f);
  assert.deepEqual(reading.numbers, { likes: 1, comments: 0, reach: 90, views: 140, saves: 5 });
  assert.equal('shares' in reading.numbers, false);
  assert.deepEqual(reading.needs, []);
});

test('a real failure is thrown, not hidden as a need', async () => {
  await assert.rejects(instagramPost('m1', 'tok', fakeFetch([[/\/m1\?/, 500, { error: { code: 2, message: 'Service temporarily unavailable' } }]])), /Instagram post failed/);
});

test('an Instagram account gives followers, yesterday, and the audience; too few followers is a need, not an error', async () => {
  const seen: string[] = [];
  const small = fakeFetch([
    [/metric=follower_demographics/, 400, { error: { code: 100, message: 'Not enough followers: a minimum of 100 followers is required' } }],
    [/metric=reach%2Cviews%2Cprofile_views/, 200, { data: [{ name: 'reach', total_value: { value: 70 } }, { name: 'views', total_value: { value: 90 } }, { name: 'profile_views', total_value: { value: 12 } }] }],
    [/\/1\?/, 200, { followers_count: 62 }],
  ], seen);
  const reading = await instagramAccount('1', 'tok', '2026-11-12', small);
  assert.deepEqual(reading.numbers, { '2026-11-12': { followers: 62 }, '2026-11-11': { reach: 70, views: 90, profileViews: 12 } });
  assert.deepEqual(reading.needs, ['followers']);
  assert.equal(reading.audience, undefined);
  assert.ok(seen.length >= 3);

  const big = fakeFetch([
    [/breakdown=age/, 200, { data: [{ total_value: { breakdowns: [{ results: [{ dimension_values: ['25-34'], value: 40 }, { dimension_values: ['18-24'], value: 22 }] }] } }] }],
    [/breakdown=gender/, 200, { data: [{ total_value: { breakdowns: [{ results: [{ dimension_values: ['F'], value: 58 }] }] } }] }],
    [/breakdown=(country|city)/, 200, { data: [{ total_value: { breakdowns: [{ results: [] }] } }] }],
    [/metric=reach%2Cviews%2Cprofile_views/, 200, { data: [] }],
    [/\/1\?/, 200, { followers_count: 500 }],
  ]);
  const full = await instagramAccount('1', 'tok', '2026-11-12', big);
  assert.deepEqual(full.audience, { age: { '25-34': 40, '18-24': 22 }, gender: { F: 58 } });
});

test('a Facebook post gives reactions, comments and shares with no new permission, and reach and clicks with read_insights', async () => {
  const none = await facebookPost('7_1', 'tok', fakeFetch([[/\/7_1\/insights/, 400, refusal], [/\/7_1\?/, 200, { message: 'Hi', permalink_url: 'https://fb/1', shares: { count: 2 }, reactions: { summary: { total_count: 9 } }, comments: { summary: { total_count: 4 } } }]]));
  assert.deepEqual(none.numbers, { likes: 9, comments: 4, shares: 2 });
  assert.deepEqual(none.needs, ['reconnect']);
  const full = await facebookPost('7_1', 'tok', fakeFetch([[/\/7_1\/insights/, 200, { data: [{ name: 'post_impressions_unique', values: [{ value: 300 }] }, { name: 'post_clicks', values: [{ value: 21 }] }] }], [/\/7_1\?/, 200, { reactions: { summary: { total_count: 1 } } }]]));
  assert.deepEqual(full.numbers, { likes: 1, reach: 300, clicks: 21 });
});

test('a Facebook page gives followers, and daily reach with read_insights', async () => {
  const f = fakeFetch([[/\/7\/insights/, 200, { data: [{ values: [{ value: 50, end_time: '2026-11-10T08:00:00+0000' }, { value: 70, end_time: '2026-11-11T08:00:00+0000' }] }] }], [/\/7\?/, 200, { followers_count: 120 }]]);
  const reading = await facebookAccount('7', 'tok', '2026-11-12', f);
  assert.deepEqual(reading.numbers, { '2026-11-12': { followers: 120 }, '2026-11-10': { reach: 50 }, '2026-11-11': { reach: 70 } });
});

test('Google gives views (all four kinds added), calls, directions, website clicks per day, and last month\'s search terms', async () => {
  const day = (d: number, v: string) => ({ date: { year: 2026, month: 11, day: d }, value: v });
  const series = (name: string, values: ReturnType<typeof day>[]) => ({ dailyMetric: name, timeSeries: { datedValues: values } });
  const f = fakeFetch([
    [/fetchMultiDailyMetricsTimeSeries/, 200, { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [series('BUSINESS_IMPRESSIONS_DESKTOP_MAPS', [day(10, '4')]), series('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', [day(10, '6')]), series('CALL_CLICKS', [day(10, '2')]), series('BUSINESS_DIRECTION_REQUESTS', [day(10, '3')]), series('WEBSITE_CLICKS', [day(11, '5')])] }] }],
    [/searchkeywords/, 200, { searchKeywordsCounts: [{ searchKeyword: 'sweets near me', insightsValue: { value: '40' } }, { searchKeyword: 'mithai', insightsValue: { threshold: '15' } }] }],
  ]);
  const reading = await googleLocation('locations/9', 'access', '2026-10-29', '2026-11-11', f);
  assert.deepEqual(reading.numbers, { '2026-11-10': { views: 10, calls: 2, directions: 3 }, '2026-11-11': { websiteClicks: 5 } });
  assert.deepEqual(reading.searchTerms, [{ term: 'sweets near me', impressions: 40 }, { term: 'mithai', impressions: 15 }]);
});

test('Google numbers still come when the search terms cannot be read', async () => {
  const f = fakeFetch([[/fetchMultiDailyMetricsTimeSeries/, 200, { multiDailyMetricTimeSeries: [] }], [/searchkeywords/, 403, { error: { message: 'no' } }]]);
  const reading = await googleLocation('locations/9', 'access', '2026-10-29', '2026-11-11', f);
  assert.deepEqual(reading, { numbers: {}, needs: [] });
});
