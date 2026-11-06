import assert from 'node:assert/strict';
import { test } from 'node:test';
import { brandIsPaused, isPaused, NO_PAUSES, parsePauses, setPause } from './pauses.ts';
import { crosspostStatusFor } from './crosspost.ts';
import { addFacebookPages, postedKey, type PostedLog } from './channels.ts';
import { editPost, type EditStore } from './editing.ts';
import { applyOverrides, parseOverrides, type OverrideMap } from './overrides.ts';
import { overallState } from './post-view.ts';
import { dueManualPosts, duePlannedPost, type ScheduledPost } from './schedule.ts';

test('a pause on everything holds every client, one on a client holds its channels, one on a channel only that channel', () => {
  assert.equal(isPaused(NO_PAUSES, 'acme', 'facebook:1'), false);
  assert.equal(isPaused({ all: true, brands: [], channels: [] }, 'anyone', 'facebook:1'), true);
  const client = { all: false, brands: ['acme'], channels: [] };
  assert.equal(isPaused(client, 'acme', 'google:5'), true);
  assert.equal(isPaused(client, 'other', 'google:5'), false);
  assert.equal(brandIsPaused(client, 'acme'), true);
  const channel = { all: false, brands: [], channels: ['facebook:1'] };
  assert.equal(isPaused(channel, 'acme', 'facebook:1'), true);
  assert.equal(isPaused(channel, 'acme', 'facebook:2'), false);
  assert.equal(brandIsPaused(channel, 'acme'), false);
});

test('pauses are switched on and off one at a time, once each, and never for an id that is not one', () => {
  let file = setPause(NO_PAUSES, 'brand', 'acme', true);
  file = setPause(setPause(file, 'brand', 'acme', true), 'channel', 'instagram', true);
  file = setPause(file, 'all', undefined, true);
  assert.deepEqual(file, { all: true, brands: ['acme'], channels: ['instagram'] });
  file = setPause(setPause(setPause(file, 'brand', 'acme', false), 'channel', 'instagram', false), 'all', undefined, false);
  assert.deepEqual(file, NO_PAUSES);
  assert.throws(() => setPause(NO_PAUSES, 'brand', '../x', true), /not a client/);
  assert.throws(() => setPause(NO_PAUSES, 'channel', 'bogus', true), /not a channel/);
});

test('a pause file is read strictly', () => {
  assert.deepEqual(parsePauses({}), NO_PAUSES);
  assert.deepEqual(parsePauses({ all: true, brands: ['a', 'a'], channels: ['google:1'] }), { all: true, brands: ['a'], channels: ['google:1'] });
  assert.throws(() => parsePauses([]), /object/);
  assert.throws(() => parsePauses({ all: 'yes' }), /true or false/);
  assert.throws(() => parsePauses({ brands: ['Bad Name'] }), /valid ids/);
  assert.throws(() => parsePauses({ channels: ['nope'] }), /valid ids/);
});

const KEY = Buffer.alloc(32, 7);
const T0 = Date.parse('2026-11-01T00:00:00Z');
const channels = addFacebookPages({ channels: [] }, 'acme', [{ id: '77', name: 'Page', accessToken: 'tok' }], KEY, T0);
const post = { id: 'p1', brand: 'acme', date: '2026-11-05T10:00:00+05:30' };
const NOW = Date.parse('2026-11-03T00:00:00Z');

test('a held post shows as paused, a skipped one as skipped, and neither is shown as missed or due', () => {
  const state = (extra: Record<string, unknown> = {}, pauses = NO_PAUSES, log: PostedLog = {}, now = NOW) => crosspostStatusFor({ ...post, ...extra }, channels, log, now, pauses)[0]?.state;
  assert.equal(state(), 'scheduled');
  assert.equal(state({}, { all: false, brands: ['acme'], channels: [] }), 'paused');
  assert.equal(state({}, { all: false, brands: [], channels: ['facebook:77'] }), 'paused');
  assert.equal(state({ skipped: true }), 'skipped');
  // Once the post's time has come and the pause held it, it is recorded as skipped, and stays so after the pause ends.
  const late = Date.parse('2026-11-05T06:00:00Z');
  const held: PostedLog = { [postedKey('p1', 'facebook:77')]: { remoteId: 'held', permalink: null, postedAt: 'x', skipped: true } };
  assert.equal(state({}, NO_PAUSES, held, late), 'skipped');
  assert.equal(crosspostStatusFor(post, channels, held, late)[0]?.permalink, null);
  // A pause on a post that went out long ago changes nothing about its being missed.
  assert.equal(state({}, { all: true, brands: [], channels: [] }, {}, Date.parse('2026-11-09T00:00:00Z')), 'missed');
});

test('one state for a post across channels: skipped ones do not count, paused is shown only when nothing else is due or missed', () => {
  const at = Date.parse('2026-11-05T10:00:00+05:30');
  assert.equal(overallState([{ state: 'skipped' }, { state: 'skipped' }], at, NOW), 'skipped');
  assert.equal(overallState([{ state: 'published' }, { state: 'skipped' }], at, NOW), 'published');
  assert.equal(overallState([{ state: 'paused' }, { state: 'scheduled' }], at, NOW), 'paused');
  assert.equal(overallState([{ state: 'paused' }, { state: 'due' }], at, NOW), 'due');
  assert.equal(overallState([{ state: 'paused' }, { state: 'missed' }], at, NOW), 'missed');
});

const posts: ScheduledPost[] = [{ id: 'future', date: '2026-11-05T10:00:00+05:30', caption: 'Original', image: '/a.jpg' }];
function memoryStore(initial: OverrideMap = {}): EditStore & { overrides: OverrideMap } {
  const state = { overrides: initial };
  return Object.assign(state, {
    load: async () => ({ overrides: structuredClone(state.overrides), etag: 'v1' }),
    save: async (o: OverrideMap) => void (state.overrides = o),
    saveImage: async () => undefined,
    deleteImage: async () => undefined,
  });
}

test('a post is skipped and unskipped through the edits, and a skip survives reverting the words', async () => {
  const store = memoryStore();
  assert.deepEqual(await editPost(store, posts, 'future', { kind: 'skip' }, T0), { post: 'future', edited: false });
  assert.equal(applyOverrides(posts, store.overrides)[0]?.skipped, true);
  await editPost(store, posts, 'future', { kind: 'caption', caption: 'Changed' }, T0);
  await editPost(store, posts, 'future', { kind: 'revert' }, T0);
  assert.equal(store.overrides['future']?.skipped, true);
  assert.equal(store.overrides['future']?.caption, undefined);
  await editPost(store, posts, 'future', { kind: 'unskip' }, T0);
  assert.deepEqual(store.overrides, {});
  assert.equal(applyOverrides(posts, store.overrides)[0]?.skipped, undefined);
  await assert.rejects(editPost(store, posts, 'future', { kind: 'skip' }, Date.parse('2026-11-06T00:00:00Z')), /already due or published/);
});

test('skipped flags are read from the overrides file and refused when malformed', () => {
  assert.equal(parseOverrides({ a: { skipped: true, updatedAt: 'x' } })['a']?.skipped, true);
  assert.throws(() => parseOverrides({ a: { skipped: 'yes', updatedAt: 'x' } }), /skipped is malformed/);
});

test('a skipped post is never picked to be sent, and skipping today\'s planned post does not bring yesterday\'s back', () => {
  const now = Date.parse('2026-11-05T04:40:00Z'); // 10:10 in India
  const yesterday: ScheduledPost = { id: 'y', brand: 'acme', date: '2026-11-04T10:00:00+05:30', caption: 'Y', image: '/y.jpg' };
  const today: ScheduledPost = { id: 't', brand: 'acme', date: '2026-11-05T10:00:00+05:30', caption: 'T', image: '/t.jpg' };
  assert.equal(duePlannedPost([yesterday, today], now)?.id, 't');
  assert.equal(duePlannedPost([yesterday, { ...today, skipped: true }], now), null);
  const own: ScheduledPost = { ...today, id: 'm', manual: true };
  assert.deepEqual(dueManualPosts([own, { ...own, id: 'm2', skipped: true }], now).map((p) => p.id), ['m']);
});
