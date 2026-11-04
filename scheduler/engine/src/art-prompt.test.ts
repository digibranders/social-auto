import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArtBrief, type ArtBrief } from './art-brief.ts';
import { buildImagePrompt, describeRegion, textRegion } from './art-prompt.ts';
import { familyById, layoutRegistry } from './layout-registry.ts';

const colors = { ink: '#14213D', accent: '#FCA311', background: '#FFFFFF', tile: '#F2F2F2' };
const brand = { colors };

const briefOf = (picture: Record<string, unknown>, layout = 'split-composition', textZone = 'left'): ArtBrief =>
  parseArtBrief({ layout, hierarchy: 'headline-first', headlineScale: 'large', alignment: 'start', textZone, picture, logoSlot: 'top-left', identitySlot: 'under-logo', ctaSlot: 'top-right' }, 'post 1');
const hero = { role: 'hero', medium: 'illustration', subject: 'a project board', action: 'with overdue cards glowing', scene: 'a quiet workspace', composition: 'close three-quarter view', mood: 'calm', paletteUse: 'balanced' };
const slotsOf = (layout: string, zone: string) => Object.entries(familyById(layoutRegistry, layout)?.zones ?? {}).find(([name]) => name === zone)?.[1]?.textSlots ?? [];

test('the prompt carries the accepted subject and action, the medium, the scene and the brand palette', () => {
  const prompt = buildImagePrompt({ brief: briefOf(hero), brand, textSlots: slotsOf('split-composition', 'left') }) ?? '';
  assert.match(prompt, /Flat geometric vector illustration/);
  assert.match(prompt, /a project board, with overdue cards glowing/);
  assert.match(prompt, /Setting: a quiet workspace\. Composition: close three-quarter view\. Mood: calm\./);
  assert.match(prompt, /#14213D/);
  assert.match(prompt, /#FCA311/);
});

test('picture role none produces no prompt, so no image can be requested', () => {
  assert.equal(buildImagePrompt({ brief: briefOf({ role: 'none' }, 'typography-hero', 'center'), brand, textSlots: slotsOf('typography-hero', 'center') }), undefined);
});

test('palette use changes the colour instruction', () => {
  const build = (paletteUse: string): string => buildImagePrompt({ brief: briefOf({ ...hero, paletteUse }), brand, textSlots: [] }) ?? '';
  assert.match(build('accent-led'), /#FCA311 as the dominant colour/);
  assert.match(build('ink-led'), /mostly deep #14213D/);
  assert.match(build('balanced'), /in balance/);
});

test('people are not banned, but text, logos, invented interfaces and credentials are', () => {
  const prompt = buildImagePrompt({ brief: briefOf(hero), brand, textSlots: [] }) ?? '';
  assert.doesNotMatch(prompt, /no people|no faces|no hands/i);
  assert.match(prompt, /no readable text, letters, numbers, logos/);
  assert.match(prompt, /not a depiction of a real product screen, place or credential/);
});

test('the reserved text area follows the real slot geometry', () => {
  const left = buildImagePrompt({ brief: briefOf(hero, 'split-composition', 'left'), brand, textSlots: slotsOf('split-composition', 'left') }) ?? '';
  const right = buildImagePrompt({ brief: briefOf(hero, 'split-composition', 'right'), brand, textSlots: slotsOf('split-composition', 'right') }) ?? '';
  const top = buildImagePrompt({ brief: briefOf(hero, 'split-composition', 'top'), brand, textSlots: slotsOf('split-composition', 'top') }) ?? '';
  assert.match(left, /left part/);
  assert.match(right, /right part/);
  assert.match(top, /full-width|upper band/);
  assert.notEqual(left, right);
});

test('a texture picture has no focal subject', () => {
  const prompt = buildImagePrompt({ brief: briefOf({ ...hero, role: 'texture', medium: 'abstract' }, 'typography-hero', 'center'), brand, textSlots: slotsOf('typography-hero', 'center') }) ?? '';
  assert.match(prompt, /subtle background texture suggested by a project board, with no single focal subject/);
  assert.doesNotMatch(prompt, /overdue cards glowing/);
});

test('textRegion and describeRegion', () => {
  assert.equal(textRegion([]), undefined);
  assert.deepEqual(textRegion([{ id: 'a', rect: { x: 10, y: 20, w: 100, h: 50 } }, { id: 'b', rect: { x: 50, y: 100, w: 100, h: 50 } }]), { x: 10, y: 20, w: 140, h: 130 });
  assert.match(describeRegion({ x: 64, y: 200, w: 460, h: 640 }), /middle left part of the frame \(about 43% wide and 59% tall\)/);
});

test('identical inputs give an identical prompt', () => {
  const run = (): string | undefined => buildImagePrompt({ brief: briefOf(hero), brand, textSlots: slotsOf('split-composition', 'left') });
  assert.equal(run(), run());
});

test('a hero picture is asked for depth and lighting only where they help, and flat or minimal is allowed; a texture is not', () => {
  const heroPrompt = buildImagePrompt({ brief: briefOf(hero), brand, textSlots: slotsOf('split-composition', 'left') }) ?? '';
  assert.match(heroPrompt, /depth, environmental context, a clear focal subject and coherent lighting where they improve the idea/);
  assert.match(heroPrompt, /minimal, flat or abstract composition is equally valid/);
  const texture = buildImagePrompt({ brief: briefOf({ ...hero, role: 'texture', medium: 'abstract' }, 'typography-hero', 'center'), brand, textSlots: slotsOf('typography-hero', 'center') }) ?? '';
  assert.doesNotMatch(texture, /environmental context/);
});


import { cropGuidance } from './art-prompt.ts';

test('a wide or tall picture panel tells the image model which central part stays visible, so the subject is not cut off; a square panel adds nothing', () => {
  assert.match(cropGuidance({ x: 0, y: 680, w: 1080, h: 400 }), /wide band that shows only the middle 37% of its height: keep the whole subject inside that central band/);
  assert.match(cropGuidance({ x: 600, y: 200, w: 416, h: 720 }), /tall panel that shows only the middle 58% of its width: keep the whole subject inside that central column/);
  assert.equal(cropGuidance({ x: 0, y: 0, w: 1080, h: 1080 }), '');
  assert.equal(cropGuidance(undefined), '');
  const slot = familyById(layoutRegistry, 'split-composition')?.zones['top']?.imageSlots[0];
  const prompt = buildImagePrompt({ brief: briefOf(hero, 'split-composition', 'top'), brand, textSlots: slotsOf('split-composition', 'top'), ...(slot ? { pictureSlot: slot.rect } : {}) }) ?? '';
  assert.match(prompt, /middle 56% of its height/);
  const full = buildImagePrompt({ brief: briefOf(hero, 'split-composition', 'top'), brand, textSlots: slotsOf('split-composition', 'top') }) ?? '';
  assert.doesNotMatch(full, /cropped to/);
});


import { sceneSizeFor } from './art-prompt.ts';

test('the scene is requested in the panel\'s shape, and the crop guidance accounts for the shape it was made in', () => {
  assert.deepEqual(sceneSizeFor({ x: 0, y: 680, w: 1080, h: 400 }), { width: 1536, height: 1024 });
  assert.deepEqual(sceneSizeFor({ x: 600, y: 200, w: 416, h: 720 }), { width: 1024, height: 1536 });
  assert.deepEqual(sceneSizeFor({ x: 0, y: 0, w: 1080, h: 1080 }, 1088), { width: 1088, height: 1088 });
  assert.deepEqual(sceneSizeFor(undefined, 1088), { width: 1088, height: 1088 });
  assert.match(cropGuidance({ x: 0, y: 680, w: 1080, h: 400 }, { width: 1536, height: 1024 }), /middle 56% of its height/);
  assert.match(cropGuidance({ x: 600, y: 200, w: 416, h: 720 }, { width: 1024, height: 1536 }), /middle 87% of its width/);
  assert.equal(cropGuidance({ x: 0, y: 0, w: 1000, h: 640 }, { width: 1536, height: 1024 }), '');
});
