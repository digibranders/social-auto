import assert from 'node:assert/strict';
import { test } from 'node:test';
import { earliestDay, postChannelId } from './new-post.ts';

test('the earliest day is tomorrow in the person\'s own calendar', () => {
  const now = new Date(2026, 10, 30, 22, 15).getTime();
  assert.equal(earliestDay(now), '2026-12-01');
  assert.equal(earliestDay(new Date(2026, 11, 31, 9, 0).getTime()), '2027-01-01');
});

test('Instagram goes by its own name in a post, other channels by their id, and a channel with no id cannot be chosen', () => {
  const base = { avatar: null, brands: ['x'], ok: true };
  assert.equal(postChannelId({ ...base, id: null, platform: 'instagram', account: 'a' }), 'instagram');
  assert.equal(postChannelId({ ...base, id: 'linkedin:abc', platform: 'linkedin', account: 'a' }), 'linkedin:abc');
  assert.equal(postChannelId({ ...base, id: null, platform: 'facebook', account: 'a' }), null);
});
