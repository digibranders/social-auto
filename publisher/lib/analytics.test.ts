import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_ANALYTICS, hashtagsOf, parseAnalytics, parseRange, recordAccount, recordPost, forgetBrand, viewFor, type AnalyticsFile } from './analytics.ts';
import { collectAnalytics, type AnalyticsReaders } from './analytics-collect.ts';
import type { Channel, PostedLog } from './channels.ts';
import { encrypt, parseKey } from './crypto.ts';

const KEY = parseKey('22'.repeat(32));
const NOW = Date.parse('2026-11-12T08:00:00Z');
const DAY = 86_400_000;

const base = (brand: string, channel: string, postedAt: string, caption = 'Hello #Diwali #mithai') => ({ brand, channel, platform: 'instagram' as const, permalink: 'https://ig/p/1', postedAt, caption, tags: hashtagsOf(caption) });

test('hashtags are found, lower-cased, de-duplicated and need two characters', () => {
  assert.deepEqual(hashtagsOf('Big #Diwali sale #diwali #a #mithai_box!'), ['diwali', 'mithai_box']);
  assert.deepEqual(hashtagsOf('no tags here'), []);
});

test('a later reading of the same day replaces the earlier one, and a number left out is kept from before', () => {
  let file = recordPost(EMPTY_ANALYTICS, 'p1|instagram:1', base('b', 'instagram:1', '2026-11-10T10:00:00Z'), '2026-11-11', { likes: 5, reach: 100 }, NOW);
  file = recordPost(file, 'p1|instagram:1', base('b', 'instagram:1', '2026-11-10T10:00:00Z'), '2026-11-11', { likes: 7 }, NOW);
  assert.deepEqual(file.posts['p1|instagram:1']?.series['2026-11-11'], { likes: 7, reach: 100 });
});

test('the view gives each post its total, leaves out a number the network did not give, and keeps brands apart', () => {
  let file: AnalyticsFile = EMPTY_ANALYTICS;
  file = recordPost(file, 'p1|instagram:1', base('mine', 'instagram:1', '2026-11-05T10:00:00Z'), '2026-11-06', { likes: 3, reach: 50 }, NOW);
  file = recordPost(file, 'p1|instagram:1', base('mine', 'instagram:1', '2026-11-05T10:00:00Z'), '2026-11-07', { likes: 9, reach: 120 }, NOW);
  file = recordPost(file, 'p2|instagram:2', base('other', 'instagram:2', '2026-11-05T10:00:00Z'), '2026-11-07', { likes: 1 }, NOW);
  const view = viewFor(file, 'mine', '2026-11-01', '2026-11-12');
  assert.equal(view.posts.length, 1);
  assert.equal(view.posts[0]?.postId, 'p1');
  assert.deepEqual(view.posts[0]?.total, { likes: 9, reach: 120 });
  assert.equal(view.posts[0]?.series.length, 2);
  assert.equal('saves' in (view.posts[0]?.total ?? {}), false, 'a number never given is absent, not 0');
  assert.deepEqual(viewFor(file, 'nobody', '2026-11-01', '2026-11-12').posts, []);
});

test('only posts made inside the range are listed', () => {
  const file = recordPost(EMPTY_ANALYTICS, 'p1|instagram:1', base('b', 'instagram:1', '2026-10-01T10:00:00Z'), '2026-11-07', { likes: 1 }, NOW);
  assert.equal(viewFor(file, 'b', '2026-11-01', '2026-11-12').posts.length, 0);
  assert.equal(viewFor(file, 'b', '2026-10-01', '2026-10-31').posts.length, 1);
});

test('hashtag figures are the average reach of the posts that used the tag, and a post without a reach number counts only as a use', () => {
  let file: AnalyticsFile = EMPTY_ANALYTICS;
  file = recordPost(file, 'a|instagram:1', base('b', 'instagram:1', '2026-11-05T10:00:00Z', '#diwali'), '2026-11-07', { reach: 100 }, NOW);
  file = recordPost(file, 'b|instagram:1', base('b', 'instagram:1', '2026-11-06T10:00:00Z', '#diwali #mithai'), '2026-11-07', { reach: 300 }, NOW);
  file = recordPost(file, 'c|instagram:1', base('b', 'instagram:1', '2026-11-07T10:00:00Z', '#mithai'), '2026-11-08', { likes: 4 }, NOW);
  assert.deepEqual(viewFor(file, 'b', '2026-11-01', '2026-11-12').hashtags, [{ tag: '#diwali', posts: 2, avgReach: 200 }, { tag: '#mithai', posts: 2, avgReach: 300 }].sort((a, b) => b.avgReach - a.avgReach));
});

test('the file survives being saved and read back, and a malformed entry is refused', () => {
  const file = recordAccount(EMPTY_ANALYTICS, 'instagram:1', { brand: 'b', channel: 'instagram:1', platform: 'instagram', label: 'shop', audience: { age: { '25-34': 40 } }, needs: ['followers'], checkedAt: '2026-11-12T08:00:00.000Z' }, { '2026-11-11': { followers: 62 } }, NOW);
  assert.deepEqual(parseAnalytics(JSON.parse(JSON.stringify(file))), file);
  assert.throws(() => parseAnalytics({ posts: { x: { brand: 1 } } }), /malformed/);
  assert.throws(() => parseAnalytics([]), /object/);
});

test('forgetting a brand removes its posts and accounts and nobody else', () => {
  let file = recordPost(EMPTY_ANALYTICS, 'a|instagram:1', base('gone', 'instagram:1', '2026-11-05T10:00:00Z'), '2026-11-07', { likes: 1 }, NOW);
  file = recordPost(file, 'b|instagram:2', base('stays', 'instagram:2', '2026-11-05T10:00:00Z'), '2026-11-07', { likes: 1 }, NOW);
  assert.deepEqual(Object.keys(forgetBrand(file, 'gone').posts), ['b|instagram:2']);
});

test('a range must be real dates, in order, and at most a year', () => {
  assert.deepEqual(parseRange('2026-11-01', '2026-11-12', NOW), { from: '2026-11-01', to: '2026-11-12' });
  assert.deepEqual(parseRange(null, null, NOW), { from: '2026-10-14', to: '2026-11-12' });
  assert.match(String(parseRange('2026-13-01', '2026-11-12', NOW)), /from must be a date/);
  assert.match(String(parseRange('2026-02-30', '2026-11-12', NOW)), /from must be a date/);
  assert.match(String(parseRange('2026-11-12', '2026-11-01', NOW)), /not be after/);
  assert.match(String(parseRange('2024-01-01', '2026-11-12', NOW)), /one year/);
});

// ---- the daily check ----------------------------------------------------------------------------------------------------------------------

const ig: Channel = { id: 'instagram:1', platform: 'instagram', brand: 'b', userId: '1', username: 'shop', token: encrypt('ig-token', KEY), expiresAt: '2027-01-01T00:00:00Z', connectedAt: '2026-10-01T00:00:00Z' };
const fb: Channel = { id: 'facebook:7', platform: 'facebook', brand: 'b', pageId: '7', pageName: 'Shop page', token: encrypt('fb-token', KEY), connectedAt: '2026-10-01T00:00:00Z' };
const gl: Channel = { id: 'google:9', platform: 'google', brand: 'b', account: 'accounts/1', location: 'locations/9', locationTitle: 'Shop', token: encrypt('g-refresh', KEY), connectedAt: '2026-10-01T00:00:00Z' };

function readers(calls: string[], overrides: Partial<AnalyticsReaders> = {}): AnalyticsReaders {
  return {
    instagramPost: async (id, token) => { calls.push(`igpost ${id} ${token}`); return { numbers: { likes: 4, reach: 90 }, caption: 'Hi #diwali', permalink: 'https://ig/p/1', needs: [] }; },
    instagramAccount: async (id, token, today) => { calls.push(`igacc ${id} ${today}`); return { numbers: { [today]: { followers: 62 } }, needs: ['followers'] }; },
    facebookPost: async (id) => { calls.push(`fbpost ${id}`); return { numbers: { likes: 2 }, needs: ['reconnect'] }; },
    facebookAccount: async (id, token, today) => { calls.push(`fbacc ${id}`); return { numbers: { [today]: { followers: 10 } }, needs: [] }; },
    googleToken: async (_app, refresh) => { calls.push(`gtoken ${refresh}`); return 'access'; },
    googleLocation: async (location, _t, since, until) => { calls.push(`glocation ${location} ${since} ${until}`); return { numbers: { '2026-11-11': { views: 30, calls: 2 } }, searchTerms: [{ term: 'sweets near me', impressions: 40 }], needs: [] }; },
    ...overrides,
  };
}

const posted = (ageDays: number, extra: Partial<PostedLog[string]> = {}): PostedLog => ({
  'p1|instagram:1': { remoteId: 'media1', permalink: 'https://ig/p/1', postedAt: new Date(NOW - ageDays * DAY).toISOString(), ...extra },
});

test('the check reads each account and each recent post once, with the saved token, and records what came back', async () => {
  const calls: string[] = [];
  const { file, report } = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [ig, fb, gl], posted: posted(2), key: KEY, googleApp: { clientId: 'c', clientSecret: 's' }, readers: readers(calls), now: NOW });
  assert.deepEqual(calls.sort(), ['fbacc 7', 'gtoken g-refresh', 'glocation locations/9 2026-10-29 2026-11-11', 'igacc 1 2026-11-12', 'igpost media1 ig-token'].sort());
  assert.deepEqual(report, { posts: 1, accounts: 3, failures: [] });
  assert.deepEqual(file.posts['p1|instagram:1']?.series['2026-11-12'], { likes: 4, reach: 90 });
  assert.deepEqual(file.posts['p1|instagram:1']?.tags, ['diwali']);
  assert.deepEqual(file.accounts['instagram:1']?.needs, ['followers']);
  assert.equal(file.accounts['google:9']?.searchTerms?.[0]?.term, 'sweets near me');
  assert.equal(file.checkedAt, new Date(NOW).toISOString());
});

test('a second check on the same day asks nothing again', async () => {
  const first = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [ig], posted: posted(2), key: KEY, googleApp: null, readers: readers([]), now: NOW });
  const calls: string[] = [];
  await collectAnalytics({ file: first.file, channels: [ig], posted: posted(2), key: KEY, googleApp: null, readers: readers(calls), now: NOW + 3_600_000 });
  assert.deepEqual(calls, []);
});

test('a post older than a week is asked about weekly, and one older than 60 days not at all', async () => {
  const first = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [ig], posted: posted(20), key: KEY, googleApp: null, readers: readers([]), now: NOW });
  const next = await collectAnalytics({ file: first.file, channels: [ig], posted: posted(20), key: KEY, googleApp: null, readers: readers([]), now: NOW + 3 * DAY });
  assert.equal(next.report.posts, 0);
  const later = await collectAnalytics({ file: first.file, channels: [ig], posted: posted(20), key: KEY, googleApp: null, readers: readers([]), now: NOW + 7 * DAY });
  assert.equal(later.report.posts, 1);
  const old = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [ig], posted: posted(61), key: KEY, googleApp: null, readers: readers([]), now: NOW });
  assert.equal(old.report.posts, 0);
});

test('posts that were held, repeated or dropped are never asked about', async () => {
  for (const extra of [{ skipped: true as const }, { duplicateOf: 'x|instagram:1' }, { reason: 'account-disconnected' }, { remoteId: 'held' }]) {
    const calls: string[] = [];
    await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [ig], posted: posted(1, extra), key: KEY, googleApp: null, readers: readers(calls), now: NOW });
    assert.deepEqual(calls.filter((c) => c.startsWith('igpost')), []);
  }
});

test('one failure does not stop the others, and a disconnected account is forgotten', async () => {
  const calls: string[] = [];
  const stale = recordPost(EMPTY_ANALYTICS, 'old|instagram:gone', base('b', 'instagram:gone', '2026-11-01T10:00:00Z'), '2026-11-02', { likes: 1 }, NOW);
  const { file, report } = await collectAnalytics({ file: stale, channels: [ig, fb], posted: posted(1), key: KEY, googleApp: null, readers: readers(calls, { instagramAccount: async () => { throw new Error('Instagram account failed: boom'); } }), now: NOW });
  assert.deepEqual(report.failures, [{ id: 'instagram:1', reason: 'Instagram account failed: boom' }]);
  assert.equal(report.accounts, 1);
  assert.equal(report.posts, 1);
  assert.equal(file.posts['old|instagram:gone'], undefined);
});

test('Google without an app set up is reported, not thrown', async () => {
  const { report } = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [gl], posted: {}, key: KEY, googleApp: null, readers: readers([]), now: NOW });
  assert.deepEqual(report.failures, [{ id: 'google:9', reason: 'Google is not set up on this server' }]);
});

test('each connected channel says where it stands, and Instagram\'s audience says why it is missing', () => {
  const at = '2026-11-12T08:00:00.000Z';
  let file: AnalyticsFile = recordAccount(EMPTY_ANALYTICS, 'instagram:1', { brand: 'b', channel: 'instagram:1', platform: 'instagram', label: 'shop', needs: ['followers'], checkedAt: at }, { '2026-11-10': { followers: 60 }, '2026-11-11': { followers: 64 } }, NOW);
  file = recordAccount(file, 'facebook:7', { brand: 'b', channel: 'facebook:7', platform: 'facebook', label: 'Page', needs: ['reconnect'], checkedAt: at }, {}, NOW);
  file = recordAccount(file, 'google:9', { brand: 'b', channel: 'google:9', platform: 'google', label: 'Loc', checkedAt: at }, {}, NOW);
  const connected = [{ id: 'instagram:1', platform: 'instagram', label: 'shop' }, { id: 'facebook:7', platform: 'facebook', label: 'Page' }, { id: 'google:9', platform: 'google', label: 'Loc' }, { id: 'google:10', platform: 'google', label: 'New' }, { id: 'linkedin:3', platform: 'linkedin', label: 'Asha' }];
  const view = viewFor(file, 'b', '2026-11-01', '2026-11-12', connected);
  assert.deepEqual(view.channels.map((c) => [c.channel, c.status, c.lastCheckedAt]), [['instagram:1', 'ok', at], ['facebook:7', 'reconnect', at], ['google:9', 'ok', at], ['google:10', 'waiting', null], ['linkedin:3', 'unsupported', null]]);
  assert.deepEqual(view.audience, { instagram: { status: 'too_few_followers', followers: 64 } });
  const withAudience = recordAccount(EMPTY_ANALYTICS, 'instagram:1', { brand: 'b', channel: 'instagram:1', platform: 'instagram', label: 'shop', audience: { age: { '18-24': 22, '25-34': 41 }, city: { Delhi: 46 } }, checkedAt: at }, {}, NOW);
  assert.deepEqual(viewFor(withAudience, 'b', '2026-11-01', '2026-11-12', connected.slice(0, 1)).audience, { instagram: { status: 'ok', age: [{ label: '25-34', value: 41 }, { label: '18-24', value: 22 }], city: [{ label: 'Delhi', value: 46 }] } });
  assert.deepEqual(viewFor(EMPTY_ANALYTICS, 'b', '2026-11-01', '2026-11-12', connected.slice(0, 1)).audience, { instagram: { status: 'none' } });
  assert.deepEqual(viewFor(EMPTY_ANALYTICS, 'b', '2026-11-01', '2026-11-12').audience, {}, 'no Instagram connected, no audience entry');
});

test('a Google connection the network withdrew is recorded as "reconnect" instead of waiting for ever', async () => {
  const { file, report } = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [gl], posted: {}, key: KEY, googleApp: { clientId: 'c', clientSecret: 's' }, readers: readers([], { googleToken: async () => { throw new Error('Google sign-in refresh failed: access was withdrawn or expired. Connect Google again from the dashboard.'); } }), now: NOW });
  assert.equal(report.failures.length, 1);
  assert.deepEqual(file.accounts['google:9']?.needs, ['reconnect']);
  assert.equal(viewFor(file, 'b', '2026-11-01', '2026-11-12', [{ id: 'google:9', platform: 'google', label: 'Shop' }]).channels[0]?.status, 'reconnect');
});

test('a check a few hours later reads again the same day, so a new like shows; one within three hours reads nothing', async () => {
  const first = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [ig], posted: posted(2), key: KEY, googleApp: null, readers: readers([]), now: NOW });
  const soon: string[] = [];
  await collectAnalytics({ file: first.file, channels: [ig], posted: posted(2), key: KEY, googleApp: null, readers: readers(soon), now: NOW + 2 * 3_600_000 });
  assert.deepEqual(soon, [], 'two hours later: nothing asked');
  const later: string[] = [];
  const again = await collectAnalytics({ file: first.file, channels: [ig], posted: posted(2), key: KEY, googleApp: null, readers: readers(later, { instagramPost: async () => ({ numbers: { likes: 5, reach: 120 }, caption: 'Hi', needs: [] }) }), now: NOW + 4 * 3_600_000 });
  assert.equal(again.report.posts, 1, 'four hours later the post is read again');
  assert.equal(again.report.accounts, 1);
  assert.equal(again.file.posts['p1|instagram:1']?.series['2026-11-12']?.likes, 5, 'the new reading replaces the old one for the day');
  assert.ok(again.file.postsRead?.['p1|instagram:1']);
});

test('a run that starts a few seconds after the three-hour mark still reads, so the timer\'s runs are never skipped', async () => {
  const first = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [ig], posted: posted(2), key: KEY, googleApp: null, readers: readers([]), now: NOW });
  const next = await collectAnalytics({ file: first.file, channels: [ig], posted: posted(2), key: KEY, googleApp: null, readers: readers([]), now: NOW + 3 * 3_600_000 - 5_000 });
  assert.equal(next.report.posts, 1);
  assert.equal(next.report.accounts, 1);
});

test('the team\'s own Instagram account is read too: its posts get the right client, its account is recorded once, and it is ignored when its settings are missing', async () => {
  const teamPosted: PostedLog = {
    'w1-d1|instagram': { remoteId: 'mediaA', permalink: 'https://ig/p/a', postedAt: new Date(NOW - 3 * DAY).toISOString() },
    'w1-d2|instagram': { remoteId: 'mediaB', permalink: 'https://ig/p/b', postedAt: new Date(NOW - 1 * DAY).toISOString() },
    'w1-d3|instagram': { remoteId: 'held', permalink: null, postedAt: new Date(NOW - 1 * DAY).toISOString() },
  };
  const calls: string[] = [];
  const team = { userId: '555', token: 'team-token', brandOfPost: (id: string) => (id.startsWith('w1') ? 'brandbasket' : undefined) };
  const { file, report } = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [], posted: teamPosted, key: KEY, googleApp: null, readers: readers(calls), now: NOW, team });
  assert.deepEqual(calls.sort(), ['igacc 555 2026-11-12', 'igpost mediaA team-token', 'igpost mediaB team-token']);
  assert.deepEqual([report.posts, report.accounts, report.failures], [2, 1, []]);
  assert.equal(file.posts['w1-d1|instagram']?.brand, 'brandbasket');
  assert.equal(file.accounts['instagram']?.brand, 'brandbasket');
  assert.equal(viewFor(file, 'brandbasket', '2026-11-01', '2026-11-30', [{ id: 'instagram', platform: 'instagram', label: 'Instagram' }]).channels[0]?.status, 'ok');
  assert.equal(viewFor(file, 'someone-else', '2026-11-01', '2026-11-30').posts.length, 0, 'another client does not see them');
  const none = await collectAnalytics({ file: EMPTY_ANALYTICS, channels: [], posted: teamPosted, key: KEY, googleApp: null, readers: readers([]), now: NOW });
  assert.deepEqual([none.report.posts, none.report.accounts], [0, 0]);
});
