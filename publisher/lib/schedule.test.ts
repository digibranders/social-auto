import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duePost, lowQueueWarnings, parseSchedule, sameCaption, ScheduleError } from './schedule.ts';

test('lowQueueWarnings reports clients whose schedule is about to run out', () => {
  const day = (brand: string, date: string) => ({ brand, id: `${brand}-${date}`, date: `${date}T10:00:00+05:30`, caption: 'c', image: '/i' });
  const now = Date.parse('2026-12-04T10:30:00+05:30');
  const posts = [
    day('a', '2026-12-04'), day('a', '2026-12-05'), day('a', '2026-12-06'),
    day('b', '2026-12-04'),
    day('c', '2026-12-05'), day('c', '2026-12-06'), day('c', '2026-12-07'),
  ];
  // a: 2 left (no warning), b: 0 left (warn), c: 3 left (warn)
  assert.deepEqual(lowQueueWarnings(posts, now), [
    { brand: 'b', postsLeft: 0 },
    { brand: 'c', postsLeft: 3 },
  ]);
});

test('lowQueueWarnings treats posts without a brand as one default client', () => {
  const now = Date.parse('2026-12-04T10:30:00+05:30');
  assert.deepEqual(lowQueueWarnings([{ id: 'x', date: '2026-12-05T10:00:00+05:30', caption: 'c', image: '/i' }], now), [
    { brand: 'default', postsLeft: 1 },
  ]);
});

const posts = parseSchedule({
  posts: [
    { id: 'a', date: '2026-10-29T10:00:00+05:30', caption: 'A', image: '/posts/a.jpg' },
    { id: 'b', date: '2026-10-30T10:00:00+05:30', caption: 'B', image: '/posts/b.jpg' },
  ],
});

test('duePost picks the post whose time has just passed', () => {
  assert.equal(duePost(posts, Date.parse('2026-10-29T10:20:00+05:30'))?.id, 'a');
  assert.equal(duePost(posts, Date.parse('2026-10-30T10:59:00+05:30'))?.id, 'b');
});

test('duePost returns nothing before the time or long after it', () => {
  assert.equal(duePost(posts, Date.parse('2026-10-29T09:59:00+05:30')), null);
  assert.equal(duePost(posts, Date.parse('2026-11-02T10:00:00+05:30')), null);
});

test('parseSchedule rejects incomplete posts', () => {
  assert.throws(() => parseSchedule({ posts: [{ id: 'x', date: 'nope', caption: 'c', image: '/i' }] }), ScheduleError);
  assert.throws(() => parseSchedule({}), ScheduleError);
});

test('sameCaption ignores whitespace differences', () => {
  assert.ok(sameCaption('Hello\n\nworld ', 'Hello world'));
  assert.ok(!sameCaption('Hello', 'Hello there'));
});
