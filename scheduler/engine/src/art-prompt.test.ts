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
