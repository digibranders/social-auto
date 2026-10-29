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
  assert.deepEqual(withError.channels[0], { platform: 'instagram', account: null, avatar: null, brands: [], ok: false, error: 'Token expired' });
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
