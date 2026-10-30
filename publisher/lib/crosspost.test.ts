import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFacebookPages, channelToken, parseChannels, parsePostedLog, removeChannel, postedKey, type PostedLog } from './channels.ts';
import { decrypt, encrypt, parseKey } from './crypto.ts';
import { facebookStatusFor, postToFacebook, type FacebookApi } from './crosspost.ts';

const KEY = parseKey('11'.repeat(32));
const T0 = Date.parse('2026-10-30T09:00:00Z');
const channels = addFacebookPages({ channels: [] }, 'brandbasket', [{ id: '77', name: 'Brandbs', accessToken: 'page-token' }], KEY, T0);
const post = { id: 'p1', brand: 'brandbasket', date: '2026-10-31T10:00:00+05:30', caption: 'Hello', image: '/posts/x.jpg' };

function fakeApi(overrides: Partial<FacebookApi> = {}): FacebookApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    postPhotoFromUrl: async (pageId, token, url, caption) => {
      calls.push(`post ${pageId} ${token} ${url} ${caption}`);
      return { photoId: 'photo1', postId: '77_post1' };
    },
    postLink: async () => 'https://facebook.com/77/posts/1',
    pageHealth: async () => ({ ok: true }),
    ...overrides,
  };
}

const run = (api: FacebookApi, extra: Partial<Parameters<typeof postToFacebook>[0]> = {}) => {
  const recorded: PostedLog = {};
  return postToFacebook({
    post, channels, key: KEY, origin: 'https://pub.example', log: {}, dryRun: false, api, now: Date.parse('2026-10-31T05:00:00Z'),
    record: async (k, e) => void (recorded[k] = e), ...extra,
  }).then((results) => ({ results, recorded }));
};

test('encrypt/decrypt round-trips, differs each time, and refuses a wrong key or edited text', () => {
  const a = encrypt('secret', KEY);
  assert.notEqual(a, encrypt('secret', KEY));
  assert.ok(!a.includes('secret'));
  assert.equal(decrypt(a, KEY), 'secret');
  assert.throws(() => decrypt(a, parseKey('22'.repeat(32))));
  assert.throws(() => decrypt(`${a.slice(0, -2)}AA`, KEY));
  assert.throws(() => parseKey('short'), /64 hex/);
});

test('channels keep the token encrypted, replace on reconnect, and can be removed', () => {
  const only = channels.channels[0]!;
  assert.ok(!only.token.includes('page-token'));
  assert.equal(channelToken(only, KEY), 'page-token');
  const again = addFacebookPages(channels, 'brandbasket', [{ id: '77', name: 'Renamed', accessToken: 'new' }], KEY, T0 + 1);
  assert.equal(again.channels.length, 1);
  assert.equal(again.channels[0]?.pageName, 'Renamed');
  assert.deepEqual(removeChannel(again, 'facebook:77').channels, []);
  assert.deepEqual(parseChannels(JSON.parse(JSON.stringify(channels))), channels);
  assert.throws(() => parseChannels({ channels: [{ id: 'x' }] }), /must be a non-empty string/);
  assert.throws(() => parsePostedLog({ k: { remoteId: 1 } }), /malformed/);
});

test('a post is sent to the Page with the poster address and caption, and recorded', async () => {
  const api = fakeApi();
  const { results, recorded } = await run(api);
  assert.deepEqual(results.map((r) => r.status), ['posted']);
  assert.equal(api.calls[0], 'post 77 page-token https://pub.example/posts/x.jpg Hello');
  assert.equal(recorded[postedKey('p1', 'facebook:77')]?.remoteId, '77_post1');
  assert.equal(results[0]?.permalink, 'https://facebook.com/77/posts/1');
});

test('a post already sent is never sent again', async () => {
  const api = fakeApi();
  const log: PostedLog = { [postedKey('p1', 'facebook:77')]: { remoteId: 'old', permalink: null, postedAt: 'x' } };
  const { results } = await run(api, { log });
  assert.equal(results[0]?.status, 'already-posted');
  assert.equal(api.calls.length, 0);
});

test('a dry run only checks the Page, and a failing Page is reported without throwing', async () => {
  const dry = fakeApi();
  assert.equal((await run(dry, { dryRun: true })).results[0]?.status, 'dry-run-ready');
  assert.equal(dry.calls.length, 0);
  const broken = fakeApi({ postPhotoFromUrl: async () => { throw new Error('Facebook photo post failed: expired'); } });
  const { results, recorded } = await run(broken);
  assert.equal(results[0]?.status, 'failed');
  assert.match(results[0]?.error ?? '', /expired/);
  assert.deepEqual(recorded, {});
  const down = fakeApi({ pageHealth: async () => ({ ok: false, error: 'token dead' }) });
  assert.equal((await run(down, { dryRun: true })).results[0]?.error, 'token dead');
});

test('posts from before a Page was connected, and other clients, are left alone', async () => {
  const early = fakeApi();
  const olderPost = { ...post, date: '2026-10-29T10:00:00+05:30' };
  assert.equal((await run(early, { post: olderPost })).results[0]?.status, 'skipped-before-connection');
  const other = fakeApi();
  assert.deepEqual((await run(other, { post: { ...post, brand: 'someone-else' } })).results, []);
  assert.equal(early.calls.length + other.calls.length, 0);
});

test('a picture-less post fails clearly, and a Page failure never blocks another Page', async () => {
  const two = addFacebookPages(channels, 'brandbasket', [{ id: '88', name: 'Second', accessToken: 't2' }], KEY, T0);
  const api = fakeApi({
    postPhotoFromUrl: async (pageId) => {
      if (pageId === '77') throw new Error('nope');
      return { photoId: 'p', postId: '88_p' };
    },
  });
  const { results } = await run(api, { channels: two });
  assert.deepEqual(results.map((r) => `${r.account}:${r.status}`), ['Brandbs:failed', 'Second:posted']);
  assert.match((await run(fakeApi(), { post: { ...post, image: null } })).results[0]?.error ?? '', /no picture/);
});

test('facebookStatusFor reports published, scheduled, due and missed per Page', () => {
  const log: PostedLog = { [postedKey('p1', 'facebook:77')]: { remoteId: 'r', permalink: 'https://f/b', postedAt: 'x' } };
  const status = (id: string, date: string, now: string) => facebookStatusFor({ id, brand: 'brandbasket', date }, channels, log, Date.parse(now))[0];
  assert.deepEqual(status('p1', '2026-10-31T10:00:00+05:30', '2026-10-31T06:00:00Z'), { platform: 'facebook', account: 'Brandbs', state: 'published', permalink: 'https://f/b' });
  assert.equal(status('p2', '2026-11-02T10:00:00+05:30', '2026-10-31T06:00:00Z')?.state, 'scheduled');
  assert.equal(status('p2', '2026-10-31T10:00:00+05:30', '2026-10-31T06:00:00Z')?.state, 'due');
  assert.equal(status('p2', '2026-10-31T10:00:00+05:30', '2026-11-03T06:00:00Z')?.state, 'missed');
  assert.deepEqual(facebookStatusFor({ id: 'old', brand: 'brandbasket', date: '2026-10-01T10:00:00+05:30' }, channels, log, T0), []);
});
