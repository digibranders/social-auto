import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStatus, StatusParseError } from './status.ts';

const valid = {
  generatedAt: '2026-12-10T05:00:00.000Z',
  channels: [{ platform: 'instagram', account: 'dai23_sy', avatar: null, brands: ['brandbasket'], ok: true }],
  posts: [
    {
      id: 'brandbasket-w01-d1',
      brand: 'brandbasket',
      platform: 'instagram',
      date: '2026-10-29T10:00:00+05:30',
      caption: 'Caption',
      image: null,
      state: 'published',
      permalink: 'https://www.instagram.com/p/abc/',
      publishedAt: '2026-10-29T04:48:28+0000',
      mediaUrl: null,
    },
  ],
  runway: [{ brand: 'brandbasket', postsLeft: 12 }],
};

test('parseStatus accepts a valid feed and fills optional channel errors', () => {
  const parsed = parseStatus(valid);
  assert.equal(parsed.posts[0]?.state, 'published');
  assert.equal(parsed.channels[0]?.error, undefined);
  const withError = parseStatus({ ...valid, channels: [{ platform: 'instagram', account: null, avatar: null, brands: [], ok: false, error: 'Token expired' }] });
  assert.deepEqual(withError.channels[0], { id: null, platform: 'instagram', account: null, avatar: null, brands: [], paused: false, ok: false, error: 'Token expired' });
});

test('parseStatus keeps a channel id and the Facebook line of a post, and defaults them when absent', () => {
  const parsed = parseStatus({
    ...valid,
    channels: [{ id: 'facebook:1499238236597230', platform: 'facebook', account: 'Page', avatar: null, brands: ['brandbasket'], ok: true }],
    posts: [{ ...valid.posts[0], crossposts: [{ platform: 'facebook', account: 'Page', state: 'published', permalink: 'https://www.facebook.com/x' }] }],
  });
  assert.equal(parsed.channels[0]?.id, 'facebook:1499238236597230');
  assert.deepEqual(parsed.posts[0]?.crossposts, [{ platform: 'facebook', account: 'Page', state: 'published', permalink: 'https://www.facebook.com/x' }]);
  assert.deepEqual(parseStatus(valid).posts[0]?.crossposts, []);
  assert.throws(() => parseStatus({ ...valid, posts: [{ ...valid.posts[0], crossposts: [{ platform: 'facebook', account: 'P', state: 'x', permalink: null }] }] }), /state must be one of/);
});

test('parseStatus rejects malformed feeds with a clear message', () => {
  assert.throws(() => parseStatus(null), StatusParseError);
  assert.throws(() => parseStatus({ ...valid, posts: 'nope' }), /status\.posts must be an array/);
  assert.throws(() => parseStatus({ ...valid, posts: [{ ...valid.posts[0], state: 'weird' }] }), /state must be one of/);
  assert.throws(() => parseStatus({ ...valid, posts: [{ ...valid.posts[0], date: 'yesterday' }] }), /not a date/);
  assert.throws(() => parseStatus({ ...valid, runway: [{ brand: 'b', postsLeft: -1 }] }), /whole number/);
  assert.throws(() => parseStatus({ ...valid, channels: [{ platform: 'myspace', account: null, avatar: null, brands: [], ok: true }] }), /platform must be one of/);
  assert.throws(() => parseStatus({ ...valid, channels: [{ platform: 'instagram', account: null, avatar: null, brands: [1], ok: true }] }), /brands\[0\] must be a string/);
});

test('parseStatus drops fields it does not know, so nothing unexpected reaches the browser', () => {
  const parsed = parseStatus({ ...valid, secret: 'x', posts: [{ ...valid.posts[0], extra: 'y' }] });
  assert.ok(!('secret' in parsed));
  assert.ok(!('extra' in (parsed.posts[0] ?? {})));
});

test('a client added in the dashboard can carry its website', () => {
  const parsed = parseStatus({ ...valid, runway: [{ brand: 'acme', postsLeft: 0, added: true, website: 'https://acme.com' }, { brand: 'b', postsLeft: 3 }] });
  assert.equal(parsed.runway[0]?.website, 'https://acme.com');
  assert.equal(parsed.runway[1]?.website, undefined);
});

test('parseStatus reads what is paused, and a paused channel, and defaults to nothing paused', () => {
  assert.deepEqual(parseStatus(valid).pauses, { all: false, brands: [], channels: [] });
  const parsed = parseStatus({
    ...valid,
    pauses: { all: false, brands: ['acme', 7], channels: ['facebook:1'] },
    channels: [{ id: 'facebook:1', platform: 'facebook', account: 'Page', avatar: null, brands: ['acme'], paused: true, ok: true }],
    posts: [{ ...valid.posts[0], state: 'skipped' }, { ...valid.posts[0], id: 'p2', state: 'paused' }],
  });
  assert.deepEqual(parsed.pauses, { all: false, brands: ['acme'], channels: ['facebook:1'] });
  assert.equal(parsed.channels[0]?.paused, true);
  assert.deepEqual(parsed.posts.map((p) => p.state), ['skipped', 'paused']);
  assert.throws(() => parseStatus({ ...valid, pauses: 'yes' }), /status\.pauses must be an object/);
});

test('a post carries the captions and pictures platforms have of their own, and nothing else', () => {
  const parsed = parseStatus({
    ...valid,
    posts: [{ ...valid.posts[0], variants: { linkedin: { caption: 'Long', image: 'https://x.test/wide.jpg', secret: 1 }, fax: { caption: 'no' }, google: 'bad' } }],
  });
  assert.deepEqual(parsed.posts[0]?.variants, { linkedin: { caption: 'Long', image: 'https://x.test/wide.jpg' } });
  assert.deepEqual(parseStatus(valid).posts[0]?.variants, {});
});

test('parseStatus keeps the AI cost entries, defaults to none, and rejects a negative or unknown one', () => {
  assert.deepEqual(parseStatus(valid).costs, []);
  const entry = { brand: 'brandbasket', post: 'brandbasket-w01-d1', purpose: 'picture', at: '2026-11-04T05:00:00.000Z', usd: 0.0138 };
  assert.deepEqual(parseStatus({ ...valid, costs: [entry, { ...entry, post: null, purpose: 'profile' }] }).costs, [entry, { ...entry, post: null, purpose: 'profile' }]);
  assert.throws(() => parseStatus({ ...valid, costs: [{ ...entry, usd: -1 }] }), StatusParseError);
  assert.throws(() => parseStatus({ ...valid, costs: [{ ...entry, purpose: 'lunch' }] }), StatusParseError);
  assert.throws(() => parseStatus({ ...valid, costs: [{ ...entry, at: 'soon' }] }), StatusParseError);
});

test('a client keeps every plan it has, each with its own platforms, and an entry that is not a plan is skipped', () => {
  const plan = (platforms: string[], postsPerWeek: number) => ({ platforms, startDate: '2026-11-06', durationDays: 31, postsPerWeek, time: '10:00', utcOffset: '+05:30' });
  const parsed = parseStatus({ ...valid, runway: [{ brand: 'acme', postsLeft: 0, added: true, website: 'https://acme.com', plans: [plan(['instagram'], 3), 'nonsense', plan(['linkedin'], 1)] }] });
  assert.deepEqual(parsed.runway[0]?.plans?.map((p) => [p.platforms, p.postsPerWeek]), [[['instagram'], 3], [['linkedin'], 1]]);
  assert.equal(parseStatus({ ...valid, runway: [{ brand: 'acme', postsLeft: 0 }] }).runway[0]?.plans, undefined);
});

test('a client that requires the real logo says so, and one that does not says nothing', () => {
  const parsed = parseStatus({ ...valid, runway: [{ brand: 'a', postsLeft: 0, added: true, requireAuthenticLogo: true }, { brand: 'b', postsLeft: 0, added: true, requireAuthenticLogo: 'yes' }, { brand: 'c', postsLeft: 0, added: true }] });
  assert.deepEqual(parsed.runway.map((r) => r.requireAuthenticLogo), [true, undefined, undefined]);
});

