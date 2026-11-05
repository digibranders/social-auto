import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RenderCandidate } from './art-resolve.ts';
import type { PostArt } from './content.ts';
import { planRepair } from './review-loop.ts';

const brief = (layout: string, textZone: string, role: 'hero' | 'none', ctaSlot: string, logoSlot = 'top-left', identitySlot = 'under-logo') =>
  ({ layout, hierarchy: 'headline-first', headlineScale: 'large', alignment: 'start', textZone, picture: { role, medium: 'abstract', subject: 's', action: 'a', scene: 'c', composition: 'x', mood: 'm', paletteUse: 'balanced' }, logoSlot, identitySlot, ctaSlot }) as unknown as RenderCandidate['brief'];
const cand = (optionId: string, b: RenderCandidate['brief'], imagePrompt?: string): RenderCandidate => ({ optionId, brief: b, ...(imagePrompt ? { imagePrompt } : {}), record: { layout: b.layout, hierarchy: b.hierarchy, textZone: b.textZone, pictureRole: b.picture.role, logoSlot: b.logoSlot, ctaSlot: b.ctaSlot } as RenderCandidate['record'] });

const split = cand('split', brief('split-composition', 'top', 'hero', 'bottom-left'), 'prompt-a');
const bleed = cand('bleed', brief('full-bleed-editorial', 'top', 'hero', 'top-right'), 'prompt-b');
const typo = cand('typo', brief('typography-hero', 'top', 'none', 'top-right'));
const art = { resolution: 'directed', candidates: [split, bleed, typo] } as PostArt;
const noPictures = (): boolean => false;

test('dropping the picture offers only the pictureless layouts, and may also leave out the subline', () => {
  const plan = planRepair(art, 'split', ['drop_picture', 'drop_subline'], noPictures);
  assert.ok('override' in plan);
  assert.deepEqual(plan.override.candidates?.map((c) => c.optionId), ['typo']);
  assert.equal(plan.override.withoutSubline, true);
  assert.equal(plan.override.cachedPicturesOnly, true);
});

test('there is no repair by dropping the picture when no pictureless layout exists', () => {
  const plan = planRepair({ ...art, candidates: [split, bleed] } as PostArt, 'split', ['drop_picture'], noPictures);
  assert.ok('impossible' in plan);
});

test('another layout is offered only if its picture already exists, so no picture is ever bought', () => {
  const plan = planRepair(art, 'split', ['relayout'], noPictures);
  assert.ok('override' in plan);
  assert.deepEqual(plan.override.candidates?.map((c) => c.optionId), ['typo']);
  const reuse = planRepair(art, 'split', ['relayout'], (c) => c.optionId === 'bleed');
  assert.ok('override' in reuse);
  assert.deepEqual(reuse.override.candidates?.map((c) => c.optionId), ['bleed', 'typo']);
});

test('a CTA that covers the picture is moved to a seat clear of it, keeping the same picture', () => {
  const plan = planRepair(art, 'split', ['move_cta'], noPictures);
  assert.ok('override' in plan);
  const [moved] = plan.override.candidates ?? [];
  assert.equal(moved?.imagePrompt, 'prompt-a');
  assert.equal(moved?.brief.ctaSlot, 'top-right');
  assert.equal(moved?.record.ctaSlot, 'top-right');
});

test('leaving out the subline alone redraws the layout that rendered', () => {
  const plan = planRepair(art, 'split', ['drop_subline'], noPictures);
  assert.ok('override' in plan);
  assert.deepEqual(plan.override.candidates?.map((c) => c.optionId), ['split']);
  assert.equal(plan.override.withoutSubline, true);
});

test('when nothing can reuse the picture, a relayout repair is reported impossible rather than guessed', () => {
  const plan = planRepair({ ...art, candidates: [split, bleed] } as PostArt, 'split', ['relayout'], noPictures);
  assert.ok('impossible' in plan);
});
