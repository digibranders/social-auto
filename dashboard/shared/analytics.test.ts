import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailySeries, followersNow, formatCount, parseAnalytics, sumAccounts } from './analytics.ts';

const answer = {
  enabled: true,
  checkedAt: '2026-11-12T08:00:00.000Z',
  posts: [
    { postId: 'p1', channel: 'instagram:1', platform: 'instagram', permalink: 'https://ig/p/1', postedAt: '2026-11-10T10:00:00Z', caption: 'Hi', total: { likes: 8, reach: 200, bogus: 5, comments: -1 }, series: [] },
    { postId: 'p2', channel: 'x', platform: 'myspace', postedAt: 'x', total: {} },
    'odd',
  ],
  accounts: [
    { channel: 'instagram:1', platform: 'instagram', label: 'shop', checkedAt: 'x', needs: ['followers', 'nonsense'], audience: { age: { '25-34': 40, bad: 'x' }, gender: {} }, series: [{ date: '2026-11-10', followers: 60, reach: 10 }, { date: '2026-11-11', followers: 62, reach: 20 }, { nodate: true }] },
    { channel: 'google:9', platform: 'google', label: 'Shop', checkedAt: 'x', series: [{ date: '2026-11-11', views: 30, calls: 2 }], searchTerms: [{ term: 'sweets', impressions: 40 }, { term: 5 }] },
  ],
  hashtags: [{ tag: 'diwali', posts: 1, avgReach: 200 }, { tag: 3 }],
};

test('a part that cannot be read is left out and the rest still shows', () => {
  const data = parseAnalytics(answer);
  assert.equal(data.enabled, true);
  assert.deepEqual(data.posts.map((p) => [p.postId, p.total]), [['p1', { likes: 8, reach: 200 }]], 'unknown platforms, odd rows, unknown and negative numbers are dropped');
  assert.deepEqual(data.accounts[0]?.needs, ['followers']);
  assert.deepEqual(data.accounts[0]?.audience, { age: { '25-34': 40 } });
  assert.equal(data.accounts[0]?.series.length, 2);
  assert.deepEqual(data.accounts[1]?.searchTerms, [{ term: 'sweets', impressions: 40 }]);
  assert.deepEqual(data.hashtags, [{ tag: 'diwali', posts: 1, avgReach: 200 }]);
  assert.throws(() => parseAnalytics([]), /not an object/);
  assert.equal(parseAnalytics({}).enabled, false);
});

test('sums say "not given" when no account ever gave the number, and never turn a missing number into 0', () => {
  const { accounts } = parseAnalytics(answer);
  assert.equal(sumAccounts(accounts, 'reach'), 30);
  assert.equal(sumAccounts(accounts, 'calls'), 2);
  assert.equal(sumAccounts(accounts, 'directions'), undefined);
  assert.equal(formatCount(undefined), 'Not given');
  assert.equal(formatCount(12345), '12,345');
  assert.equal(followersNow(accounts), 62, 'the newest count of each account');
  assert.deepEqual(dailySeries(accounts, 'reach'), [{ date: '2026-11-10', value: 10 }, { date: '2026-11-11', value: 20 }]);
});
