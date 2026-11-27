import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editPost, type EditStore } from './editing.ts';
import { applyOverrides, EditError, parseOverrides, splitId, type OverrideMap } from './overrides.ts';
import { dueManualPosts, postsLeftByBrand, type ScheduledPost } from './schedule.ts';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const MAIN = '2026-11-05T10:00:00+05:30';
const LINKEDIN = '2026-11-06T16:30:00+05:30';

const planned = (over: Partial<ScheduledPost> = {}): ScheduledPost => ({
  id: 'acme-w01-d1',
  brand: 'acme',
  date: MAIN,
  caption: 'Instagram words',
  image: '/posts/ig.jpg',
  channels: ['instagram', 'linkedin:abc'],
  fromPlan: true,
  ownTime: true,
  variants: { linkedin: { caption: 'LinkedIn words', image: '/posts/li.jpg' } },
  ...over,
});

function memoryStore(initial: OverrideMap = {}): EditStore & { overrides: OverrideMap } {
  const state = { overrides: initial };
  return Object.assign(state, {
    load: async () => ({ overrides: structuredClone(state.overrides), etag: 'v1' }),
    save: async (o: OverrideMap) => void (state.overrides = o),
    saveImage: async () => undefined,
    deleteImage: async () => undefined,
  });
}

const withLinkedInTime: OverrideMap = { 'acme-w01-d1': { networkDates: { linkedin: LINKEDIN }, updatedAt: '2026-11-01T00:00:00Z' } };

test('a network with a time of its own becomes a post of its own, with its own words, picture, account and time; the others stay on the post', () => {
  const [main, linkedin, ...rest] = applyOverrides([planned()], withLinkedInTime);
  assert.equal(rest.length, 0);
  assert.equal(main?.id, 'acme-w01-d1');
  assert.deepEqual(main?.channels, ['instagram']);
  assert.equal(main?.date, MAIN);
  assert.equal(main?.caption, 'Instagram words');
  assert.equal(linkedin?.id, 'acme-w01-d1~linkedin');
  assert.equal(linkedin?.splitOf, 'acme-w01-d1');
  assert.deepEqual(linkedin?.channels, ['linkedin:abc']);
  assert.equal(linkedin?.date, LINKEDIN);
  assert.equal(linkedin?.caption, 'LinkedIn words');
  assert.equal(linkedin?.image, '/posts/li.jpg');
  assert.equal(linkedin?.ownTime, true);
  assert.equal(linkedin?.variants, undefined);
});

test('nothing is split when no network has a time of its own, when it equals the post\'s, or when the post goes to one network', () => {
  assert.equal(applyOverrides([planned()], {}).length, 1);
  assert.equal(applyOverrides([planned()], { 'acme-w01-d1': { networkDates: { linkedin: MAIN }, updatedAt: 'x' } }).length, 1);
  assert.equal(applyOverrides([planned({ channels: ['linkedin:abc'] })], withLinkedInTime).length, 1, 'a post that goes only to LinkedIn is one post (its date is moved whole by the move itself)');
  const nothingToSplit = applyOverrides([planned({ channels: ['instagram'] })], withLinkedInTime);
  assert.equal(nothingToSplit.length, 1, 'a network the post does not go to has no part of it');
});

test('a skip and the main move apply to the post and to the part split off it, which keeps its own time', () => {
  const skipped = applyOverrides([planned()], { 'acme-w01-d1': { ...withLinkedInTime['acme-w01-d1'], skipped: true, updatedAt: 'x' } as never });
  assert.deepEqual(skipped.map((p) => p.skipped), [true, true]);
  const moved = applyOverrides([planned()], { 'acme-w01-d1': { ...withLinkedInTime['acme-w01-d1'], date: '2026-11-09T10:00:00+05:30', updatedAt: 'x' } as never });
  assert.deepEqual(moved.map((p) => p.date), ['2026-11-09T10:00:00+05:30', LINKEDIN]);
});

test('a part split off is sent at its own time and the rest at the post\'s: they are due separately', () => {
  const parts = applyOverrides([planned()], withLinkedInTime);
  const at = (iso: string) => dueManualPosts(parts, Date.parse(iso)).map((p) => p.id);
  assert.deepEqual(at('2026-11-05T04:40:00Z'), ['acme-w01-d1'], 'Instagram at its time');
  assert.deepEqual(at('2026-11-06T11:10:00Z'), ['acme-w01-d1~linkedin'], 'LinkedIn at its own');
});

test('the id of a part names its post and network; any other id is a post', () => {
  assert.deepEqual(splitId('acme-w01-d1~linkedin'), { base: 'acme-w01-d1', network: 'linkedin' });
  assert.deepEqual(splitId('acme-w01-d1'), { base: 'acme-w01-d1', network: null });
  assert.deepEqual(splitId('acme~nowhere'), { base: 'acme~nowhere', network: null });
});

test('moving one network saves its own time and leaves the post\'s; moving it back to the post\'s moment puts it back on the post', async () => {
  const store = memoryStore();
  await editPost(store, [planned()], 'acme-w01-d1', { kind: 'moveNetwork', network: 'linkedin', day: '2026-11-06', time: '16:30' }, NOW);
  assert.equal(store.overrides['acme-w01-d1']?.networkDates?.['linkedin'], LINKEDIN);
  assert.equal(store.overrides['acme-w01-d1']?.date, undefined);
  await editPost(store, [planned()], 'acme-w01-d1', { kind: 'moveNetwork', network: 'linkedin', day: '2026-11-05', time: '10:00' }, NOW);
  assert.equal(store.overrides['acme-w01-d1'], undefined, 'nothing left to keep');
});

test('a move of a part\'s own id is that network\'s time, and a time without a day keeps the network\'s own day', async () => {
  const store = memoryStore(structuredClone(withLinkedInTime));
  await editPost(store, [planned()], 'acme-w01-d1~linkedin', { kind: 'move', day: '2026-11-06', time: '18:00' }, NOW);
  assert.equal(store.overrides['acme-w01-d1']?.networkDates?.['linkedin'], '2026-11-06T18:00:00+05:30');
  assert.equal(store.overrides['acme-w01-d1']?.date, undefined, 'the post\'s own time did not move');
});

test('moving a network the post does not go to is refused; a post that goes to one network is moved whole', async () => {
  const store = memoryStore();
  await assert.rejects(editPost(store, [planned()], 'acme-w01-d1', { kind: 'moveNetwork', network: 'google', day: '2026-11-06' }, NOW), (e: unknown) => e instanceof EditError && /does not go to that network/.test(e.message));
  await assert.rejects(editPost(store, [planned()], 'acme-w01-d1', { kind: 'moveNetwork', network: 'tiktok', day: '2026-11-06' }, NOW), (e: unknown) => e instanceof EditError && e.status === 400);
  await editPost(store, [planned({ channels: ['linkedin:abc'] })], 'acme-w01-d1', { kind: 'moveNetwork', network: 'linkedin', day: '2026-11-06', time: '16:30' }, NOW);
  assert.equal(store.overrides['acme-w01-d1']?.date, LINKEDIN, 'the post itself moved');
  assert.equal(store.overrides['acme-w01-d1']?.networkDates, undefined);
});

test('a network whose own time has passed cannot be moved, even when the post\'s own is still ahead', async () => {
  const store = memoryStore({ 'acme-w01-d1': { networkDates: { linkedin: '2026-10-30T10:00:00+05:30' }, updatedAt: 'x' } });
  await assert.rejects(editPost(store, [planned()], 'acme-w01-d1', { kind: 'moveNetwork', network: 'linkedin', day: '2026-11-07' }, NOW), (e: unknown) => e instanceof EditError && e.status === 409);
});

test('network times survive a revert, and are read back from storage; a bad one is dropped', async () => {
  const kept = parseOverrides({ a: { networkDates: { linkedin: LINKEDIN, nope: LINKEDIN, instagram: 'not a date' }, updatedAt: 'x' } });
  assert.deepEqual(kept['a']?.networkDates, { linkedin: LINKEDIN });
  const store = memoryStore(structuredClone(withLinkedInTime));
  await editPost(store, [planned()], 'acme-w01-d1', { kind: 'revert' }, NOW);
  assert.equal(store.overrides['acme-w01-d1']?.networkDates?.['linkedin'], LINKEDIN);
});

test('a network\'s own time is the same topic, not another post left in the runway', () => {
  const parts = applyOverrides([planned()], withLinkedInTime);
  assert.equal(parts.length, 2);
  assert.equal(postsLeftByBrand(parts, NOW).get('acme'), 1);
});
