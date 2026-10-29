import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editPost, type EditStore } from './editing.ts';
import {
  applyOverrides,
  EditError,
  MAX_CAPTION_LENGTH,
  parseOverrides,
  validateCaption,
  validateJpeg,
  type OverrideMap,
} from './overrides.ts';
import type { ScheduledPost } from './schedule.ts';

/** A minimal JPEG header: SOI, then a baseline start-of-frame carrying the size. */
function jpeg(width: number, height: number, extra = 0): Uint8Array {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
  return Uint8Array.from([...bytes, ...new Array<number>(extra).fill(0)]);
}

const NOW = Date.parse('2026-11-01T00:00:00Z');
const posts: ScheduledPost[] = [
  { id: 'future', date: '2026-11-05T10:00:00+05:30', caption: 'Original #one', image: '/posts/x/a.jpg' },
  { id: 'past', date: '2026-10-30T10:00:00+05:30', caption: 'Old', image: null },
];

function memoryStore(initial: OverrideMap = {}): EditStore & { overrides: OverrideMap; images: Set<string> } {
  const state = { overrides: initial, images: new Set<string>() };
  return Object.assign(state, {
    load: async () => ({ overrides: structuredClone(state.overrides), etag: 'v1' }),
    save: async (o: OverrideMap) => void (state.overrides = o),
    saveImage: async (key: string) => void state.images.add(key),
    deleteImage: async (key: string) => void state.images.delete(key),
  });
}

test('validateCaption trims and enforces Instagram limits', () => {
  assert.equal(validateCaption('  hello #a  '), 'hello #a');
  assert.throws(() => validateCaption('   '), EditError);
  assert.throws(() => validateCaption(42), EditError);
  assert.throws(() => validateCaption('x'.repeat(MAX_CAPTION_LENGTH + 1)), /2201 characters/);
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ');
  assert.throws(() => validateCaption(tags), /31 hashtags/);
  assert.equal(validateCaption(Array.from({ length: 30 }, (_, i) => `#t${i}`).join(' ')).length > 0, true);
});

test('validateJpeg accepts a square jpg and rejects the rest', () => {
  assert.deepEqual(validateJpeg(jpeg(1080, 1080)), { width: 1080, height: 1080 });
  assert.throws(() => validateJpeg(jpeg(1080, 1350)), /square/);
  assert.throws(() => validateJpeg(jpeg(100, 100)), /at least 320/);
  assert.throws(() => validateJpeg(jpeg(5000, 5000)), /at most 4096/);
  assert.throws(() => validateJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0])), /JPG/);
  assert.throws(() => validateJpeg(new Uint8Array()), /no picture/);
  assert.throws(() => validateJpeg(jpeg(1080, 1080, 5 * 1024 * 1024)), (e: unknown) => e instanceof EditError && e.status === 413);
});

test('applyOverrides swaps caption and picture and flags the post as edited', () => {
  const key = 'a'.repeat(32);
  const [future, past] = applyOverrides(posts, { future: { caption: 'New', imageKey: key, updatedAt: 'x' } });
  assert.equal(future?.caption, 'New');
  assert.equal(future?.image, `/api/edited-image?k=${key}`);
  assert.equal(future?.edited, true);
  assert.equal(past?.edited, false);
  assert.equal(past?.caption, 'Old');
});

test('parseOverrides rejects malformed data', () => {
  assert.throws(() => parseOverrides([]), /object/);
  assert.throws(() => parseOverrides({ a: { updatedAt: 1 } }), /malformed/);
  assert.throws(() => parseOverrides({ a: { updatedAt: 'x', imageKey: '../../etc' } }), /imageKey/);
  assert.deepEqual(parseOverrides({ a: { updatedAt: 'x', caption: 'c' } }), { a: { updatedAt: 'x', caption: 'c' } });
});

test('editPost saves a caption, and reverts when it matches the original again', async () => {
  const store = memoryStore();
  await editPost(store, posts, 'future', { kind: 'caption', caption: ' Changed #two ' }, NOW);
  assert.equal(store.overrides['future']?.caption, 'Changed #two');
  await editPost(store, posts, 'future', { kind: 'caption', caption: 'Original #one' }, NOW);
  assert.deepEqual(store.overrides, {});
});

test('editPost replaces a picture, removes the previous one, and revert clears everything', async () => {
  const store = memoryStore();
  await editPost(store, posts, 'future', { kind: 'image', bytes: jpeg(1080, 1080) }, NOW);
  const first = store.overrides['future']?.imageKey as string;
  assert.ok(store.images.has(first));
  await editPost(store, posts, 'future', { kind: 'image', bytes: jpeg(1080, 1080) }, NOW);
  const second = store.overrides['future']?.imageKey as string;
  assert.notEqual(first, second);
  assert.deepEqual([...store.images], [second]);
  await editPost(store, posts, 'future', { kind: 'caption', caption: 'Keeps the picture' }, NOW);
  assert.equal(store.overrides['future']?.imageKey, second);
  const result = await editPost(store, posts, 'future', { kind: 'revert' }, NOW);
  assert.equal(result.edited, false);
  assert.deepEqual(store.overrides, {});
  assert.equal(store.images.size, 0);
});

test('editPost refuses unknown, past and invalid edits without touching storage', async () => {
  const store = memoryStore();
  await assert.rejects(editPost(store, posts, 'nope', { kind: 'revert' }, NOW), (e: unknown) => e instanceof EditError && e.status === 404);
  await assert.rejects(editPost(store, posts, 'past', { kind: 'caption', caption: 'x' }, NOW), (e: unknown) => e instanceof EditError && e.status === 409);
  await assert.rejects(editPost(store, posts, 'future', { kind: 'image', bytes: jpeg(10, 10) }, NOW), EditError);
  assert.deepEqual(store.overrides, {});
  assert.equal(store.images.size, 0);
});

test('a failed save does not leave the uploaded picture behind', async () => {
  const store = memoryStore();
  store.save = async () => {
    throw new EditError('conflict', 409);
  };
  await assert.rejects(editPost(store, posts, 'future', { kind: 'image', bytes: jpeg(1080, 1080) }, NOW), /conflict/);
  assert.equal(store.images.size, 0);
});
