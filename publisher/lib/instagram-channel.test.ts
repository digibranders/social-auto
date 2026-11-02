import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addInstagramAccount, addFacebookPages, channelLabel, channelToken, expiringSoon, parseChannels, postedKey, renewInstagramToken, type PostedLog } from './channels.ts';
import { parseKey } from './crypto.ts';
import { crosspostStatusFor, postToInstagram, type InstagramApi } from './crosspost.ts';

const KEY = parseKey('11'.repeat(32));
const T0 = Date.parse('2026-10-30T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ACCOUNT = { userId: '17841400000000001', username: 'acme_foods' };
const connected = addInstagramAccount({ channels: [] }, 'brandbasket', ACCOUNT, 'ig-token', 60 * 24 * 60 * 60, KEY, T0);
const post = { id: 'p1', brand: 'brandbasket', date: '2026-10-31T10:00:00+05:30', caption: 'Hello', image: '/posts/x.jpg' };

function fakeApi(overrides: Partial<InstagramApi> = {}): InstagramApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    createImageContainer: async (userId, token, url, caption) => {
      calls.push(`container ${userId} ${token} ${url} ${caption}`);
      return 'c1';
    },
    waitUntilReady: async (id) => void calls.push(`ready ${id}`),
    publishContainer: async (userId, _token, id) => {
      calls.push(`publish ${userId} ${id}`);
      return 'm9';
    },
    permalink: async () => 'https://www.instagram.com/p/abc/',
    tokenHealth: async () => ({ ok: true }),
    ...overrides,
  };
}

const run = (api: InstagramApi, extra: Partial<Parameters<typeof postToInstagram>[0]> = {}) => {
  const recorded: PostedLog = {};
  return postToInstagram({
    post, channels: connected, key: KEY, origin: 'https://pub.example', log: {}, dryRun: false, api, now: Date.parse('2026-10-31T05:00:00Z'),
    record: async (k, e) => void (recorded[k] = e), ...extra,
  }).then((results) => ({ results, recorded }));
};

test('an Instagram connection keeps its token encrypted, works out its end date, and survives a round trip', () => {
  const only = connected.channels[0]!;
  assert.equal(only.id, 'instagram:17841400000000001');
  assert.ok(!only.token.includes('ig-token'));
  assert.equal(channelToken(only, KEY), 'ig-token');
  assert.equal(channelLabel(only), 'acme_foods');
  assert.deepEqual(parseChannels(JSON.parse(JSON.stringify(connected))), connected);
  assert.throws(() => parseChannels({ channels: [{ ...only, expiresAt: 'soon' }] }), /not a date/);
  assert.throws(() => parseChannels({ channels: [{ ...only, userId: '' }] }), /userId/);
  const again = addInstagramAccount(connected, 'brandbasket', ACCOUNT, 'newer', 100, KEY, T0 + 1);
  assert.equal(again.channels.length, 1);
  assert.equal(channelToken(again.channels[0]!, KEY), 'newer');
});

test('renewing replaces the token and end date of one account only', () => {
  const other = addInstagramAccount(connected, 'brandbasket', { userId: '2', username: 'other' }, 'other-token', 60 * 24 * 60 * 60, KEY, T0);
  const renewed = renewInstagramToken(other, 'instagram:17841400000000001', 'renewed', 30 * 24 * 60 * 60, KEY, T0 + 7 * DAY);
  const [first, second] = renewed.channels as [(typeof renewed.channels)[number], (typeof renewed.channels)[number]];
  assert.equal(channelToken(first, KEY), 'renewed');
  assert.equal(first.platform === 'instagram' && first.expiresAt, new Date(T0 + 37 * DAY).toISOString());
  assert.equal(channelToken(second, KEY), 'other-token');
});

test('a post goes to the customer account with the picture address, is published, and recorded', async () => {
  const api = fakeApi();
  const { results, recorded } = await run(api);
  assert.deepEqual(results.map((r) => r.status), ['posted']);
  assert.deepEqual(api.calls, [
    'container 17841400000000001 ig-token https://pub.example/posts/x.jpg Hello',
    'ready c1',
    'publish 17841400000000001 c1',
  ]);
  assert.equal(recorded[postedKey('p1', 'instagram:17841400000000001')]?.remoteId, 'm9');
  assert.equal(recorded[postedKey('p1', 'instagram:17841400000000001')]?.permalink, 'https://www.instagram.com/p/abc/');
});

test('Instagram never repeats a post, skips earlier days, honours the chosen channels, and ignores other clients', async () => {
  const api = fakeApi();
  const log: PostedLog = { [postedKey('p1', 'instagram:17841400000000001')]: { remoteId: 'old', permalink: null, postedAt: 'x' } };
  assert.equal((await run(api, { log })).results[0]?.status, 'already-posted');
  assert.equal((await run(api, { post: { ...post, date: '2026-10-29T10:00:00+05:30' } })).results[0]?.status, 'skipped-before-connection');
  assert.deepEqual((await run(api, { post: { ...post, brand: 'someone-else' } })).results, []);
  assert.deepEqual((await run(api, { post: { ...post, channels: ['facebook:77'] } })).results, []);
  assert.equal(api.calls.length, 0);
});

test('an expired connection fails with what to do, and an Instagram error is reported without throwing', async () => {
  const api = fakeApi();
  const late = await run(api, { now: T0 + 61 * DAY, post: { ...post, date: new Date(T0 + 61 * DAY).toISOString() } });
  assert.equal(late.results[0]?.status, 'failed');
  assert.match(late.results[0]?.error ?? '', /acme_foods has expired.*Allow/);
  const broken = await run(fakeApi({ publishContainer: async () => { throw new Error('Instagram publish failed: denied'); } }));
  assert.equal(broken.results[0]?.status, 'failed');
  assert.deepEqual(broken.recorded, {});
});

test('a dry run checks the token and posts nothing', async () => {
  const api = fakeApi();
  assert.equal((await run(api, { dryRun: true })).results[0]?.status, 'dry-run-ready');
  assert.equal((await run(fakeApi({ tokenHealth: async () => ({ ok: false, error: 'revoked' }) }), { dryRun: true })).results[0]?.error, 'revoked');
  assert.equal(api.calls.length, 0);
});

test('expiring warnings cover Instagram connections, and the status shows them alongside the other channels', () => {
  const both = addFacebookPages(connected, 'brandbasket', [{ id: '77', name: 'Brandbs', accessToken: 'p' }], KEY, T0);
  assert.deepEqual(expiringSoon(both, T0 + 53 * DAY).map((w) => [w.channel.platform, w.days]), [['instagram', 7]]);
  const states = crosspostStatusFor(post, both, {}, Date.parse('2026-10-31T05:00:00Z'));
  assert.deepEqual(states.map((s) => s.platform).sort(), ['facebook', 'instagram']);
});
