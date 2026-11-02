import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFacebookPages, addGoogleLocation, addLinkedInMember, channelLabel, channelToken, daysLeft, expiringSoon, parseChannels, parsePostedLog, removeChannel, postedKey, type PostedLog } from './channels.ts';
import { decrypt, encrypt, parseKey } from './crypto.ts';
import { openPending, PENDING_TTL_MS, sealPending } from './google-pending.ts';
import { crosspostStatusFor, postToFacebook, postToGoogle, postToLinkedIn, type FacebookApi, type GoogleApi, type LinkedInApi } from './crosspost.ts';

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
  assert.equal(channelLabel(again.channels[0]!), 'Renamed');
  assert.deepEqual(removeChannel(again, 'facebook:77').channels, []);
  assert.deepEqual(parseChannels(JSON.parse(JSON.stringify(channels))), channels);
  assert.throws(() => parseChannels({ channels: [{ id: 'x', platform: 'facebook' }] }), /must be a non-empty string/);
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

test('crosspostStatusFor reports published, scheduled, due and missed per Page', () => {
  const log: PostedLog = { [postedKey('p1', 'facebook:77')]: { remoteId: 'r', permalink: 'https://f/b', postedAt: 'x' } };
  const status = (id: string, date: string, now: string) => crosspostStatusFor({ id, brand: 'brandbasket', date }, channels, log, Date.parse(now))[0];
  assert.deepEqual(status('p1', '2026-10-31T10:00:00+05:30', '2026-10-31T06:00:00Z'), { platform: 'facebook', account: 'Brandbs', state: 'published', permalink: 'https://f/b' });
  assert.equal(status('p2', '2026-11-02T10:00:00+05:30', '2026-10-31T06:00:00Z')?.state, 'scheduled');
  assert.equal(status('p2', '2026-10-31T10:00:00+05:30', '2026-10-31T06:00:00Z')?.state, 'due');
  assert.equal(status('p2', '2026-10-31T10:00:00+05:30', '2026-11-03T06:00:00Z')?.state, 'missed');
  assert.deepEqual(crosspostStatusFor({ id: 'old', brand: 'brandbasket', date: '2026-10-01T10:00:00+05:30' }, channels, log, T0), []);
});

const DAY = 24 * 60 * 60 * 1000;
const withLinkedIn = addLinkedInMember({ channels: [] }, 'brandbasket', { urn: 'urn:li:person:abc', name: 'Asha Rao' }, 'li-token', 60 * 24 * 60 * 60, KEY, T0);

function fakeLinkedIn(overrides: Partial<LinkedInApi> = {}): LinkedInApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImage: async (url) => {
      calls.push(`fetch ${url}`);
      return new Uint8Array([1, 2, 3]);
    },
    uploadImage: async (token, owner, bytes) => {
      calls.push(`upload ${token} ${owner} ${bytes.length}`);
      return 'urn:li:digitalmediaAsset:A1';
    },
    postImage: async (token, author, asset, caption, visibility) => {
      calls.push(`post ${author} ${asset} ${caption} ${visibility}`);
      return { urn: 'urn:li:share:9', url: 'https://www.linkedin.com/feed/update/urn:li:share:9/' };
    },
    memberHealth: async () => ({ ok: true }),
    ...overrides,
  };
}

const runLinkedIn = (api: LinkedInApi, extra: Partial<Parameters<typeof postToLinkedIn>[0]> = {}) => {
  const recorded: PostedLog = {};
  return postToLinkedIn({
    post, channels: withLinkedIn, key: KEY, origin: 'https://pub.example', log: {}, dryRun: false, api, now: Date.parse('2026-10-31T05:00:00Z'),
    record: async (k, e) => void (recorded[k] = e), ...extra,
  }).then((results) => ({ results, recorded }));
};

test('a LinkedIn connection keeps its token encrypted, works out its end date, and survives a round trip', () => {
  const only = withLinkedIn.channels[0]!;
  assert.equal(only.id, 'linkedin:abc');
  assert.ok(!only.token.includes('li-token'));
  assert.equal(channelToken(only, KEY), 'li-token');
  assert.equal(only.platform === 'linkedin' && daysLeft(only, T0), 60);
  assert.deepEqual(parseChannels(JSON.parse(JSON.stringify(withLinkedIn))), withLinkedIn);
  assert.throws(() => parseChannels({ channels: [{ ...only, expiresAt: 'soon' }] }), /not a date/);
  const again = addLinkedInMember(withLinkedIn, 'brandbasket', { urn: 'urn:li:person:abc', name: 'Asha R.' }, 'new', 100, KEY, T0 + 1);
  assert.equal(again.channels.length, 1);
  assert.equal(channelLabel(again.channels[0]!), 'Asha R.');
});

test('a post goes to LinkedIn with the picture fetched, uploaded, and shared publicly, then is recorded', async () => {
  const api = fakeLinkedIn();
  const { results, recorded } = await runLinkedIn(api);
  assert.deepEqual(results.map((r) => r.status), ['posted']);
  assert.deepEqual(api.calls, [
    'fetch https://pub.example/posts/x.jpg',
    'upload li-token urn:li:person:abc 3',
    'post urn:li:person:abc urn:li:digitalmediaAsset:A1 Hello PUBLIC',
  ]);
  assert.equal(recorded[postedKey('p1', 'linkedin:abc')]?.remoteId, 'urn:li:share:9');
});

test('LinkedIn never repeats a post, skips earlier days, and ignores other clients', async () => {
  const api = fakeLinkedIn();
  const log: PostedLog = { [postedKey('p1', 'linkedin:abc')]: { remoteId: 'old', permalink: null, postedAt: 'x' } };
  assert.equal((await runLinkedIn(api, { log })).results[0]?.status, 'already-posted');
  assert.equal((await runLinkedIn(api, { post: { ...post, date: '2026-10-29T10:00:00+05:30' } })).results[0]?.status, 'skipped-before-connection');
  assert.deepEqual((await runLinkedIn(api, { post: { ...post, brand: 'someone-else' } })).results, []);
  assert.equal(api.calls.length, 0);
});

test('an expired LinkedIn connection fails with what to do, and a LinkedIn error is reported without throwing', async () => {
  const api = fakeLinkedIn();
  const late = await runLinkedIn(api, { now: T0 + 61 * DAY, post: { ...post, date: new Date(T0 + 61 * DAY).toISOString() } });
  assert.equal(late.results[0]?.status, 'failed');
  assert.match(late.results[0]?.error ?? '', /expired.*connect link/);
  assert.equal(api.calls.length, 0);
  const broken = fakeLinkedIn({ uploadImage: async () => { throw new Error('LinkedIn picture upload failed: 401'); } });
  const { results, recorded } = await runLinkedIn(broken);
  assert.match(results[0]?.error ?? '', /401/);
  assert.deepEqual(recorded, {});
  assert.equal((await runLinkedIn(fakeLinkedIn(), { dryRun: true })).results[0]?.status, 'dry-run-ready');
  const down = fakeLinkedIn({ memberHealth: async () => ({ ok: false, error: 'token revoked' }) });
  assert.equal((await runLinkedIn(down, { dryRun: true })).results[0]?.error, 'token revoked');
});

test('both platforms show in the dashboard status, and expiry warnings fire once on 7, 3, 1 and 0 days', () => {
  const both = { channels: [...channels.channels, ...withLinkedIn.channels] };
  const states = crosspostStatusFor({ id: 'p2', brand: 'brandbasket', date: '2026-11-02T10:00:00+05:30' }, both, {}, Date.parse('2026-10-31T06:00:00Z'));
  assert.deepEqual(states.map((s) => `${s.platform}:${s.account}:${s.state}`), ['facebook:Brandbs:scheduled', 'linkedin:Asha Rao:scheduled']);
  const warn = (daysAfter: number) => expiringSoon(both, T0 + 60 * DAY - daysAfter * DAY - 1000).map((w) => w.days);
  assert.deepEqual([warn(8), warn(7), warn(6), warn(3), warn(2), warn(1), warn(0)], [[], [7], [], [3], [], [1], [0]]);
});

test('a post limited to some channels is sent only to those, and shown only for those', async () => {
  const both = { channels: [...channels.channels, ...withLinkedIn.channels] };
  const onlyLinkedIn = { ...post, channels: ['linkedin:abc'] };
  const fb = fakeApi();
  assert.deepEqual((await run(fb, { channels: both, post: onlyLinkedIn })).results, []);
  assert.equal(fb.calls.length, 0);
  const li = fakeLinkedIn();
  assert.deepEqual((await runLinkedIn(li, { channels: both, post: onlyLinkedIn })).results.map((r) => r.status), ['posted']);
  assert.deepEqual((await runLinkedIn(li, { channels: both, post: { ...post, channels: ['instagram'] } })).results, []);
  const states = crosspostStatusFor({ id: 'p9', brand: 'brandbasket', date: '2026-11-02T10:00:00+05:30', channels: ['linkedin:abc'] }, both, {}, Date.parse('2026-10-31T06:00:00Z'));
  assert.deepEqual(states.map((s) => s.platform), ['linkedin']);
});

const withGoogle = addGoogleLocation({ channels: [] }, 'brandbasket', { account: 'accounts/1', location: 'locations/10', title: 'Cafe One' }, 'refresh-1', KEY, T0);

function fakeGoogle(overrides: Partial<GoogleApi> = {}): GoogleApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    postUpdate: async (token, place, update) => {
      calls.push(`post ${token} ${place.account}/${place.location} ${update.imageUrl} | ${update.summary}`);
      return { name: 'accounts/1/locations/10/localPosts/5', url: 'https://google.com/search?q=cafe' };
    },
    locationHealth: async () => ({ ok: true }),
    ...overrides,
  };
}

const runGoogle = (api: GoogleApi, extra: Partial<Parameters<typeof postToGoogle>[0]> = {}) => {
  const recorded: PostedLog = {};
  return postToGoogle({
    post, channels: withGoogle, key: KEY, origin: 'https://pub.example', log: {}, dryRun: false, api, now: Date.parse('2026-10-31T05:00:00Z'),
    record: async (k, e) => void (recorded[k] = e), ...extra,
  }).then((results) => ({ results, recorded }));
};

test('a Google location keeps its refresh token encrypted and survives a round trip', () => {
  const only = withGoogle.channels[0]!;
  assert.equal(only.id, 'google:10');
  assert.ok(!only.token.includes('refresh-1'));
  assert.equal(channelToken(only, KEY), 'refresh-1');
  assert.equal(channelLabel(only), 'Cafe One');
  assert.deepEqual(parseChannels(JSON.parse(JSON.stringify(withGoogle))), withGoogle);
  assert.throws(() => parseChannels({ channels: [{ ...only, location: '' }] }), /location must be a non-empty string/);
  const again = addGoogleLocation(withGoogle, 'brandbasket', { account: 'accounts/1', location: 'locations/10', title: 'Renamed' }, 'new', KEY, T0 + 1);
  assert.equal(again.channels.length, 1);
  assert.equal(channelLabel(again.channels[0]!), 'Renamed');
});

test('a post goes to Google as an update with the public picture address and a hashtag-free caption, then is recorded', async () => {
  const api = fakeGoogle();
  const { results, recorded } = await runGoogle(api, { post: { ...post, caption: 'Hello #tag' } });
  assert.deepEqual(results.map((r) => r.status), ['posted']);
  assert.equal(api.calls[0], 'post refresh-1 accounts/1/locations/10 https://pub.example/posts/x.jpg | Hello');
  assert.equal(recorded[postedKey('p1', 'google:10')]?.remoteId, 'accounts/1/locations/10/localPosts/5');
  assert.equal(results[0]?.permalink, 'https://google.com/search?q=cafe');
});

test('Google never repeats a post, skips earlier days and other clients, and honours the chosen channels', async () => {
  const api = fakeGoogle();
  const log: PostedLog = { [postedKey('p1', 'google:10')]: { remoteId: 'old', permalink: null, postedAt: 'x' } };
  assert.equal((await runGoogle(api, { log })).results[0]?.status, 'already-posted');
  assert.equal((await runGoogle(api, { post: { ...post, date: '2026-10-29T10:00:00+05:30' } })).results[0]?.status, 'skipped-before-connection');
  assert.deepEqual((await runGoogle(api, { post: { ...post, brand: 'someone-else' } })).results, []);
  assert.deepEqual((await runGoogle(api, { post: { ...post, channels: ['instagram'] } })).results, []);
  assert.equal(api.calls.length, 0);
});

test('a Google failure is reported without throwing, a dry run only checks, and a picture-less post is refused', async () => {
  const broken = fakeGoogle({ postUpdate: async () => { throw new Error('Google post failed: Phone numbers are not allowed'); } });
  const { results, recorded } = await runGoogle(broken);
  assert.match(results[0]?.error ?? '', /Phone numbers/);
  assert.deepEqual(recorded, {});
  const dry = fakeGoogle();
  assert.equal((await runGoogle(dry, { dryRun: true })).results[0]?.status, 'dry-run-ready');
  assert.equal(dry.calls.length, 0);
  const down = fakeGoogle({ locationHealth: async () => ({ ok: false, error: 'access was withdrawn' }) });
  assert.equal((await runGoogle(down, { dryRun: true })).results[0]?.error, 'access was withdrawn');
  assert.match((await runGoogle(fakeGoogle(), { post: { ...post, image: null } })).results[0]?.error ?? '', /no picture/);
});

test('Google shows in the dashboard status next to the other channels', () => {
  const both = { channels: [...channels.channels, ...withGoogle.channels] };
  const states = crosspostStatusFor({ id: 'p2', brand: 'brandbasket', date: '2026-11-02T10:00:00+05:30' }, both, {}, Date.parse('2026-10-31T06:00:00Z'));
  assert.deepEqual(states.map((s) => `${s.platform}:${s.account}:${s.state}`), ['facebook:Brandbs:scheduled', 'google:Cafe One:scheduled']);
});

test('a waiting Google connection opens only for its client, before it ends, and nothing readable leaves the server', () => {
  const sealed = sealPending('refresh-9', 'brandbasket', KEY, T0);
  assert.ok(!sealed.includes('refresh-9'));
  assert.equal(openPending(sealed, 'brandbasket', KEY, T0 + 60_000), 'refresh-9');
  assert.throws(() => openPending(sealed, 'someone-else', KEY, T0 + 60_000), /another client/);
  assert.throws(() => openPending(sealed, 'brandbasket', KEY, T0 + PENDING_TTL_MS + 1), /expired/);
  assert.throws(() => openPending('v1.junk', 'brandbasket', KEY, T0), /not valid/);
  assert.throws(() => openPending(sealed, 'brandbasket', parseKey('22'.repeat(32)), T0), /not valid/);
});
