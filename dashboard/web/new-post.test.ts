import assert from 'node:assert/strict';
import { test } from 'node:test';
import { earliestDay, postChannelId, timeProblem } from './new-post.ts';

test('the earliest day is today in the person\'s own calendar', () => {
  assert.equal(earliestDay(new Date(2026, 10, 30, 9, 0).getTime()), '2026-11-30');
  assert.equal(earliestDay(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31');
});

test('a time is refused when it is malformed or has already passed, and accepted when it is still ahead', () => {
  const now = new Date(2026, 10, 4, 12, 0).getTime();
  assert.equal(timeProblem('2026-11-04', '12:05', now), null);
  assert.equal(timeProblem('2026-11-05', '08:00', now), null);
  assert.match(timeProblem('2026-11-04', '12:00', now) ?? '', /already passed/);
  assert.match(timeProblem('2026-11-04', '09:30', now) ?? '', /already passed/);
  assert.match(timeProblem('2026-11-04', '25:00', now) ?? '', /like 12:05/);
  assert.match(timeProblem('2026-11-04', '', now) ?? '', /like 12:05/);
});

test('Instagram goes by its own name in a post, other channels by their id, and a channel with no id cannot be chosen', () => {
  const base = { avatar: null, brands: ['x'], ok: true };
  assert.equal(postChannelId({ ...base, id: null, platform: 'instagram', account: 'a' }), 'instagram');
  assert.equal(postChannelId({ ...base, id: 'linkedin:abc', platform: 'linkedin', account: 'a' }), 'linkedin:abc');
  assert.equal(postChannelId({ ...base, id: 'instagram:17841400000000001', platform: 'instagram', account: 'a' }), 'instagram:17841400000000001');
  assert.equal(postChannelId({ ...base, id: null, platform: 'facebook', account: 'a' }), null);
});
