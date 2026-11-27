import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editPost, type EditStore } from './editing.ts';
import { applyOverrides, parseOverrides, type OverrideMap } from './overrides.ts';
import { dueManualPosts, duePlannedPost, type ScheduledPost } from './schedule.ts';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const planned = (id: string, day: string, brand = 'acme'): ScheduledPost => ({ id, brand, date: `${day}T10:00:00+05:30`, caption: id, image: '/a.jpg' });
const posts: ScheduledPost[] = [planned('a', '2026-11-05'), planned('b', '2026-11-06'), planned('other', '2026-11-08', 'beta'), { ...planned('mine', '2026-11-09'), manual: true }];

function memoryStore(initial: OverrideMap = {}): EditStore & { overrides: OverrideMap } {
  const state = { overrides: initial };
  return Object.assign(state, {
    load: async () => ({ overrides: structuredClone(state.overrides), etag: 'v1' }),
    save: async (o: OverrideMap) => void (state.overrides = o),
    saveImage: async () => undefined,
    deleteImage: async () => undefined,
  });
}

test('a planned post moves to a free day and keeps its time of day', async () => {
  const store = memoryStore();
  await editPost(store, posts, 'a', { kind: 'move', day: '2026-11-12' }, NOW);
  assert.equal(store.overrides['a']?.date, '2026-11-12T10:00:00+05:30');
  assert.equal(applyOverrides(posts, store.overrides).find((p) => p.id === 'a')?.date, '2026-11-12T10:00:00+05:30');
  // The original day is free now, and moving it back takes the move away again.
  await editPost(store, posts, 'b', { kind: 'move', day: '2026-11-05' }, NOW);
  await editPost(store, posts, 'a', { kind: 'move', day: '2026-11-05' }, NOW).catch(() => undefined);
  assert.equal(store.overrides['b']?.date, '2026-11-05T10:00:00+05:30');
});

test('a day that already has a planned post of the same client is refused, another client\'s is not', async () => {
  const store = memoryStore();
  await assert.rejects(editPost(store, posts, 'a', { kind: 'move', day: '2026-11-06' }, NOW), /another post is already planned for that day/);
  await editPost(store, posts, 'a', { kind: 'move', day: '2026-11-08' }, NOW);
  assert.equal(store.overrides['a']?.date, '2026-11-08T10:00:00+05:30');
  // A skipped post still holds its day: the daily run would pick it first and drop it.
  const skippedStore = memoryStore({ b: { skipped: true, updatedAt: 'x' } });
  await assert.rejects(editPost(skippedStore, posts, 'a', { kind: 'move', day: '2026-11-06' }, NOW), /already planned/);
});

test('moving back to its own day removes the move, and a post that came due, a bad day or a hand-made post is refused', async () => {
  const store = memoryStore({ a: { date: '2026-11-12T10:00:00+05:30', updatedAt: 'x' } });
  await editPost(store, posts, 'a', { kind: 'move', day: '2026-11-05' }, NOW);
  assert.deepEqual(store.overrides, {});
  await assert.rejects(editPost(memoryStore(), posts, 'a', { kind: 'move', day: '2026-10-30' }, NOW), /already passed/);
  await assert.rejects(editPost(memoryStore(), posts, 'a', { kind: 'move', day: '2027-03-01' }, NOW), /within the next 90 days/);
  await assert.rejects(editPost(memoryStore(), posts, 'a', { kind: 'move', day: 'soon' }, NOW), /choose a day/);
  await assert.rejects(editPost(memoryStore(), posts, 'a', { kind: 'move', day: '2026-11-12' }, Date.parse('2026-11-06T00:00:00Z')), /already due or published/);
  await assert.rejects(editPost(memoryStore(), posts, 'mine', { kind: 'move', day: '2026-11-12' }, NOW), /moved in its own file/);
});

test('a moved post is judged by the day it was moved to, and reverting the words keeps the move', async () => {
  const store = memoryStore({ a: { date: '2026-11-20T10:00:00+05:30', updatedAt: 'x' } });
  // Its planned day (5 Nov) has passed, but it now goes out on 20 Nov, so it can still be edited.
  await editPost(store, posts, 'a', { kind: 'caption', caption: 'New words' }, Date.parse('2026-11-10T00:00:00Z'));
  await editPost(store, posts, 'a', { kind: 'revert' }, Date.parse('2026-11-10T00:00:00Z'));
  assert.equal(store.overrides['a']?.date, '2026-11-20T10:00:00+05:30');
  assert.equal(store.overrides['a']?.caption, undefined);
});

test('a malformed move in the overrides file is refused', () => {
  assert.equal(parseOverrides({ a: { date: '2026-11-12T10:00:00+05:30', updatedAt: 'x' } })['a']?.date, '2026-11-12T10:00:00+05:30');
  assert.throws(() => parseOverrides({ a: { date: 'soon', updatedAt: 'x' } }), /date is malformed/);
});

test('a planned post can take a time as well as a day, or only a new time on its own day', async () => {
  const store = memoryStore();
  await editPost(store, posts, 'a', { kind: 'move', day: '2026-11-12', time: '15:30' }, NOW);
  assert.equal(store.overrides['a']?.date, '2026-11-12T15:30:00+05:30');
  const retimed = memoryStore();
  await editPost(retimed, posts, 'a', { kind: 'move', day: '2026-11-05', time: '08:15' }, NOW);
  assert.equal(retimed.overrides['a']?.date, '2026-11-05T08:15:00+05:30');
  // Back to the day and time it was planned for takes the change away; a time left out keeps the planned one.
  await editPost(retimed, posts, 'a', { kind: 'move', day: '2026-11-05', time: '10:00' }, NOW);
  assert.deepEqual(retimed.overrides, {});
  await assert.rejects(editPost(memoryStore(), posts, 'a', { kind: 'move', day: '2026-11-12', time: '25:00' }, NOW), /choose a time/);
  // A day that has another planned post is still refused, whatever the time.
  await assert.rejects(editPost(memoryStore(), posts, 'a', { kind: 'move', day: '2026-11-06', time: '16:00' }, NOW), /already planned/);
});

test('a planned post with a day or time of its own is sent by the frequent run, and a plain one is left to the daily run', () => {
  const now = Date.parse('2026-11-12T10:05:00Z'); // 15:35 in India
  const overrides: OverrideMap = { a: { date: '2026-11-12T15:30:00+05:30', updatedAt: 'x' } };
  const all = applyOverrides(posts, overrides);
  assert.equal(all.find((p) => p.id === 'a')?.ownTime, true);
  assert.equal(all.find((p) => p.id === 'b')?.ownTime, undefined);
  assert.deepEqual(dueManualPosts(all, now, 15 * 60 * 1000).map((p) => p.id), ['a']);
  // A skipped one is never picked, and the daily run still picks only one planned post.
  assert.deepEqual(dueManualPosts(applyOverrides(posts, { a: { ...overrides['a'], skipped: true } as OverrideMap[string] }), now, 15 * 60 * 1000), []);
  assert.equal(duePlannedPost(all, now)?.id, 'a');
});

test('several posts with a time of their own can share a day, and each is sent at its own time; a plain planned post still holds its day', async () => {
  // b already has a time of its own (moved earlier, or approved with its plan's time): a takes the same day, at another time.
  const withOwn: ScheduledPost[] = [planned('a', '2026-11-05'), { ...planned('b', '2026-11-06'), ownTime: true }];
  const store = memoryStore();
  await editPost(store, withOwn, 'a', { kind: 'move', day: '2026-11-06', time: '16:30' }, NOW);
  assert.equal(store.overrides['a']?.date, '2026-11-06T16:30:00+05:30');
  const both = applyOverrides(withOwn, store.overrides);
  // Both are sent by the frequent run, each inside its own window.
  const at = (time: string): number => Date.parse(`2026-11-06T${time}:00+05:30`);
  assert.deepEqual(dueManualPosts(both, at('10:05')).map((p) => p.id), ['b']);
  assert.deepEqual(dueManualPosts(both, at('16:35')).map((p) => p.id), ['a']);
  // A third post moved to the same day is fine too.
  const three: ScheduledPost[] = [...withOwn, planned('c', '2026-11-07')];
  await editPost(store, three, 'c', { kind: 'move', day: '2026-11-06', time: '19:00' }, NOW);
  assert.equal(store.overrides['c']?.date, '2026-11-06T19:00:00+05:30');
  // A plain planned post on the day (no time of its own) still refuses another, so the daily run never has to drop one.
  const plain: ScheduledPost[] = [planned('a', '2026-11-05'), planned('b', '2026-11-06')];
  await assert.rejects(editPost(memoryStore(), plain, 'a', { kind: 'move', day: '2026-11-06', time: '16:30' }, NOW), /another post is already planned for that day/);
});
