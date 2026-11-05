import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editPost, type EditStore } from './editing.ts';
import { buildManualPost, editManualPost, parseManualFile, toScheduled } from './manual.ts';
import { applyOverrides, parseOverrides, type OverrideMap } from './overrides.ts';
import { scheduledView } from './post-view.ts';
import type { ScheduledPost } from './schedule.ts';
import { applyVariantPatch, forPlatform, mergeViews, validateVariants } from './variants.ts';

const NOW = Date.parse('2026-11-01T00:00:00Z');
const KEY = 'a'.repeat(32);
const KEY2 = 'b'.repeat(32);
const planned: ScheduledPost = { id: 'p1', brand: 'acme', date: '2026-11-05T10:00:00+05:30', caption: 'Main words #one', image: '/main.jpg' };

function memoryStore(initial: OverrideMap = {}): EditStore & { overrides: OverrideMap; deleted: string[] } {
  const state = { overrides: initial, deleted: [] as string[] };
  return Object.assign(state, {
    load: async () => ({ overrides: structuredClone(state.overrides), etag: 'v1' }),
    save: async (o: OverrideMap) => void (state.overrides = o),
    saveImage: async () => undefined,
    deleteImage: async (key: string) => void state.deleted.push(key),
  });
}

test('validateVariants keeps what a platform changes and drops empty ones', () => {
  assert.deepEqual(validateVariants({ linkedin: { caption: ' Long words ', pictureId: KEY }, google: null, facebook: {}, instagram: { caption: '' } }), { linkedin: { caption: 'Long words', imageKey: KEY } });
});

test('validateVariants refuses an unknown platform, bad picture and bad caption', () => {
  assert.throws(() => validateVariants({ twitter: { caption: 'x' } }), /not a platform/);
  assert.throws(() => validateVariants({ linkedin: { pictureId: 'nope' } }), /not a picture/);
  assert.throws(() => validateVariants({ linkedin: { caption: 'x'.repeat(2300) } }), /characters/);
  assert.throws(() => validateVariants([]), /object/);
});

test('a platform sends its own caption and picture, and falls back to the main ones', () => {
  const post: ScheduledPost = { ...planned, variants: { linkedin: { caption: 'Long' }, google: { image: '/wide.jpg' } } };
  assert.equal(forPlatform(post, 'linkedin').caption, 'Long');
  assert.equal(forPlatform(post, 'linkedin').image, '/main.jpg');
  assert.equal(forPlatform(post, 'google').caption, 'Main words #one');
  assert.equal(forPlatform(post, 'google').image, '/wide.jpg');
  assert.equal(forPlatform(post, 'instagram'), post);
  assert.equal(forPlatform(planned, 'facebook'), planned);
});

test('mergeViews lets the newer version win field by field', () => {
  assert.deepEqual(mergeViews({ linkedin: { caption: 'a', image: '/x' } }, { linkedin: { caption: 'b' }, google: { caption: 'g' } }), { linkedin: { caption: 'b', image: '/x' }, google: { caption: 'g' } });
  assert.equal(mergeViews(undefined, undefined), undefined);
});

test('a dashboard edit of variants is applied on top of a planned post, saved, and can be cleared', async () => {
  const store = memoryStore();
  await editPost(store, [planned], 'p1', { kind: 'variants', variants: { linkedin: { caption: 'Long words', pictureId: KEY } } }, NOW);
  const sent = applyOverrides([planned], store.overrides)[0] as ScheduledPost;
  assert.equal(sent.caption, 'Main words #one');
  assert.deepEqual(sent.variants, { linkedin: { caption: 'Long words', image: `/api/edited-image?k=${KEY}` } });
  // Replacing the set drops a picture no platform uses any more.
  await editPost(store, [planned], 'p1', { kind: 'variants', variants: { google: { caption: 'Plain' }, linkedin: { pictureId: null } } }, NOW);
  assert.deepEqual(store.deleted, [KEY]);
  assert.deepEqual(store.overrides['p1']?.variants, { linkedin: { caption: 'Long words' }, google: { caption: 'Plain' } });
  await editPost(store, [planned], 'p1', { kind: 'variants', variants: { linkedin: null, google: null } }, NOW);
  assert.deepEqual(store.overrides, {});
});

test('reverting a post also drops its per-channel versions and their pictures', async () => {
  const store = memoryStore({ p1: { variants: { linkedin: { imageKey: KEY2 } }, updatedAt: 'x' } });
  await editPost(store, [planned], 'p1', { kind: 'revert' }, NOW);
  assert.deepEqual(store.overrides, {});
  assert.deepEqual(store.deleted, [KEY2]);
});

test('variants survive being read back from storage, and a malformed set is ignored', () => {
  const read = parseOverrides({ p1: { variants: { linkedin: { caption: 'x' } }, updatedAt: 'x' }, p2: { variants: { nope: 1 }, updatedAt: 'x' } });
  assert.deepEqual(read['p1']?.variants, { linkedin: { caption: 'x' } });
  assert.equal(read['p2']?.variants, undefined);
});

test('a hand-made post takes variants when made and changed, and sends them as its own', () => {
  const post = buildManualPost({ brand: 'acme', day: '2026-11-05', caption: 'Main', imageKey: KEY, channels: ['linkedin:1', 'google:2'], variants: { linkedin: { caption: 'Long' } } }, ['linkedin:1', 'google:2'], NOW);
  assert.deepEqual(post.variants, { linkedin: { caption: 'Long' } });
  assert.deepEqual(toScheduled(post).variants, { linkedin: { caption: 'Long' } });
  const changed = editManualPost(post, { variants: { google: { caption: 'Plain', pictureId: KEY2 } } }, ['linkedin:1', 'google:2'], NOW);
  assert.deepEqual(changed.variants, { linkedin: { caption: 'Long' }, google: { caption: 'Plain', imageKey: KEY2 } });
  assert.deepEqual(editManualPost(changed, { variants: { google: null } }, [], NOW).variants, { linkedin: { caption: 'Long' } });
  assert.equal(editManualPost(changed, { variants: { google: null, linkedin: null } }, [], NOW).variants, undefined);
  assert.deepEqual(editManualPost(post, { variants: { linkedin: { caption: 'Longer' }, google: { caption: 'Plain' } } }, [], NOW).variants, { linkedin: { caption: 'Longer' }, google: { caption: 'Plain' } });
  assert.deepEqual(parseManualFile({ posts: [changed] }).posts[0]?.variants, changed.variants);
  const plain = buildManualPost({ brand: 'acme', day: '2026-11-05', caption: 'Main', imageKey: KEY, channels: ['google:2'] }, ['google:2'], NOW);
  assert.equal('variants' in plain, false);
});

test('a product sees which platforms have their own version', () => {
  const post: ScheduledPost = { ...planned, variants: { linkedin: { caption: 'Long', image: '/wide.jpg' } } };
  const view = scheduledView(post, { channels: [] }, {}, NOW, 'https://x.test');
  assert.deepEqual(view['variants'], { linkedin: { caption: 'Long', imageUrl: 'https://x.test/wide.jpg' } });
  assert.equal('variants' in scheduledView(planned, { channels: [] }, {}, NOW, 'https://x.test'), false);
});

test('a variant change touches only what it names', () => {
  const start = { linkedin: { caption: 'Long', imageKey: KEY }, google: { caption: 'Plain' } };
  assert.deepEqual(applyVariantPatch(start, { linkedin: { caption: 'Longer' } }), { linkedin: { caption: 'Longer', imageKey: KEY }, google: { caption: 'Plain' } });
  assert.deepEqual(applyVariantPatch(start, { google: null }), { linkedin: { caption: 'Long', imageKey: KEY } });
  assert.deepEqual(applyVariantPatch(start, { linkedin: { caption: null, pictureId: null } }), { google: { caption: 'Plain' } });
  assert.deepEqual(applyVariantPatch(undefined, {}), {});
  assert.throws(() => applyVariantPatch(start, { fax: { caption: 'x' } }), /not a platform/);
  assert.throws(() => applyVariantPatch(start, { linkedin: 'x' }), /object or null/);
});

test('the status feed lists a post\'s own platform versions and matches Instagram on its own caption', async () => {
  const { buildStatus } = await import('./schedule.ts');
  const post: ScheduledPost = { ...planned, variants: { instagram: { caption: 'Short' }, linkedin: { caption: 'Long', image: '/wide.jpg' } } };
  const media = [{ id: 'm1', caption: 'Short', permalink: 'https://instagram.test/p/1', timestamp: '2026-11-05T04:30:00+0000', mediaUrl: null }];
  const [row] = buildStatus([post], media as never, Date.parse('2026-11-05T06:00:00Z'), 'https://x.test').posts;
  assert.equal(row?.state, 'published');
  assert.deepEqual(row?.variants, { instagram: { caption: 'Short' }, linkedin: { caption: 'Long', image: 'https://x.test/wide.jpg' } });
});
