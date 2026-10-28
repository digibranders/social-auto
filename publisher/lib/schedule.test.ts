import assert from 'node:assert/strict';
import { test } from 'node:test';
import { duePost, parseSchedule, sameCaption, ScheduleError } from './schedule.ts';

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
