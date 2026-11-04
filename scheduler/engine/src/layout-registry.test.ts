import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArtBrief, type ArtBrief } from './art-brief.ts';
import { CANVAS_SIZE } from './layout.ts';
import { checkBriefAgainstFamily, enabledFamilies, familyById, layoutRegistry, validateRegistry, type LayoutFamily } from './layout-registry.ts';

const briefFor = (layout: string, over: Record<string, unknown> = {}): ArtBrief =>
  parseArtBrief(
    {
      layout,
      hierarchy: 'headline-first',
      headlineScale: 'large',
      alignment: 'start',
      textZone: 'left',
      picture: { role: 'hero', medium: 'illustration', subject: 's', action: 'a', scene: 'sc', composition: 'c', mood: 'm', paletteUse: 'balanced' },
      logoSlot: 'top-left',
      identitySlot: 'under-logo',
      ctaSlot: 'top-right',
      ...over,
    },
    'post 1',
  );

const kinds = (brief: ArtBrief, registry: readonly LayoutFamily[] = layoutRegistry): string[] => checkBriefAgainstFamily(brief, registry).problems.map((p) => p.kind);

test('v1 ships six families with distinct ids, all validated for the square canvas', () => {
  assert.deepEqual(
    layoutRegistry.map((f) => f.id),
    ['typography-hero', 'split-composition', 'full-bleed-editorial', 'feature-spotlight', 'structured-information', 'evidence-spotlight'],
  );
  assert.deepEqual(validateRegistry(layoutRegistry), []);
  for (const family of layoutRegistry) assert.ok(family.supportedRatios.includes('1:1'), family.id);
});

test('the registry declares no industry words', () => {
  const text = JSON.stringify(layoutRegistry).toLowerCase();
  for (const word of ['clinic', 'restaurant', 'saas', 'bank', 'dental', 'retail', 'hotel']) assert.ok(!text.includes(word), word);
});

test('every slot lies inside the canvas and has a positive size', () => {
  for (const family of layoutRegistry) {
    const zoneSlots = Object.values(family.zones).flatMap((zone) => [...(zone?.textSlots ?? []), ...(zone?.imageSlots ?? [])]);
    for (const slot of [...zoneSlots, ...family.logoSlots, ...family.identitySlots, ...family.ctaSlots]) {
      const { x, y, w, h } = slot.rect;
      assert.ok(w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= CANVAS_SIZE && y + h <= CANVAS_SIZE, `${family.id}/${slot.id}`);
    }
  }
});

test('every zone has a headline slot, and every family has a logo, identity and CTA slot and offers more than one placement for brand elements', () => {
  for (const family of layoutRegistry) {
    for (const [name, zone] of Object.entries(family.zones)) assert.ok(zone?.textSlots.some((s) => s.id === 'headline'), `${family.id}/${name}`);
    assert.ok(family.logoSlots.length >= 1 && family.identitySlots.length >= 1 && family.ctaSlots.length >= 1, family.id);
  }
  assert.ok(layoutRegistry.some((f) => f.ctaSlots.length > 1), 'some family lets the CTA move');
  const placements = new Set(layoutRegistry.map((f) => JSON.stringify(f.logoSlots.map((s) => s.rect))));
  assert.ok(placements.size > 1, 'families do not all place the logo the same way');
});

test('every family can seat its logo, identity line and CTA without touching each other or the text', () => {
  const broken: LayoutFamily = {
    ...(layoutRegistry[0] as LayoutFamily),
    id: 'broken',
    logoSlots: [{ id: 'on-headline', rect: { x: 64, y: 220, w: 420, h: 72 } }],
  };
  assert.ok(validateRegistry([broken, ...layoutRegistry.slice(1)]).some((p) => /broken.*placement/.test(p)));
});

test('families that need content say what, and the safest family needs nothing', () => {
  assert.deepEqual(familyById(layoutRegistry, 'structured-information')?.requiredContent, ['list']);
  assert.deepEqual(familyById(layoutRegistry, 'evidence-spotlight')?.requiredContent, ['evidence']);
  assert.deepEqual(familyById(layoutRegistry, 'feature-spotlight')?.requiredContent, ['offering']);
  assert.deepEqual(familyById(layoutRegistry, 'typography-hero')?.requiredContent, []);
});

test('fallbacks point at a family that exists and needs no content, with no cycles', () => {
  for (const family of layoutRegistry) {
    if (family.fallbackFamily === undefined) continue;
    const next = familyById(layoutRegistry, family.fallbackFamily);
    assert.ok(next, family.id);
    assert.deepEqual(next?.requiredContent, [], family.id);
  }
  const looped = layoutRegistry.map((f) => (f.id === 'typography-hero' ? { ...f, fallbackFamily: 'split-composition' } : f));
  assert.ok(validateRegistry(looped).some((p) => /cycle|fallback/.test(p)));
});

test('validateRegistry reports duplicate ids, unknown fallbacks and slots outside the canvas', () => {
  const first = layoutRegistry[0] as LayoutFamily;
  assert.ok(validateRegistry([first, { ...first }]).some((p) => /duplicate/i.test(p)));
  assert.ok(validateRegistry([{ ...first, fallbackFamily: 'nowhere' }]).some((p) => /fallback.*nowhere/.test(p)));
  const outside: LayoutFamily = { ...first, zones: { center: { textSlots: [{ id: 'headline', rect: { x: 900, y: 100, w: 400, h: 100 } }], imageSlots: [] } } };
  assert.ok(validateRegistry([outside]).some((p) => /outside the canvas/.test(p)));
});

test('a brief that fits its family passes', () => {
  assert.deepEqual(checkBriefAgainstFamily(briefFor('split-composition'), layoutRegistry), { ok: true, problems: [] });
});

test('an unknown layout is reported, not guessed', () => {
  assert.deepEqual(kinds(briefFor('nowhere')), ['unknown_layout']);
});

test('hierarchy, text zone, picture role and medium must be ones the family allows', () => {
  assert.ok(kinds(briefFor('typography-hero', { hierarchy: 'picture-first' })).includes('hierarchy_not_allowed'));
  assert.ok(kinds(briefFor('typography-hero', { textZone: 'left' })).includes('text_zone_not_allowed'));
  assert.ok(kinds(briefFor('typography-hero', { textZone: 'center' })).includes('picture_role_not_allowed'));
  assert.deepEqual(kinds(briefFor('typography-hero', { textZone: 'center', picture: { role: 'none' } })), []);
});

test('a family that forbids a medium rejects it', () => {
  const picky: LayoutFamily = { ...(layoutRegistry[1] as LayoutFamily), allowedMediums: ['illustration'] };
  const brief = briefFor('split-composition', {
    picture: { role: 'hero', medium: 'photo-like', subject: 's', action: 'a', scene: 'sc', composition: 'c', mood: 'm', paletteUse: 'balanced' },
  });
  assert.ok(kinds(brief, [picky]).includes('picture_medium_not_allowed'));
});

test('slots must belong to the chosen family', () => {
  assert.ok(kinds(briefFor('split-composition', { logoSlot: 'floating' })).includes('unknown_slot'));
  assert.ok(kinds(briefFor('split-composition', { identitySlot: 'floating' })).includes('unknown_slot'));
  assert.ok(kinds(briefFor('split-composition', { ctaSlot: 'floating' })).includes('unknown_slot'));
});

test('chosen brand elements must not overlap each other or the text', () => {
  const split = familyById(layoutRegistry, 'split-composition') as LayoutFamily;
  const ids = (slots: LayoutFamily['logoSlots']): string[] => slots.map((s) => s.id);
  let collided = false;
  for (const logo of ids(split.logoSlots)) {
    for (const cta of ids(split.ctaSlots)) {
      const found = kinds(briefFor('split-composition', { logoSlot: logo, ctaSlot: cta }));
      if (found.includes('slot_collision')) collided = true;
    }
  }
  assert.ok(collided, 'at least one combination collides and is reported');
  assert.ok(ids(split.logoSlots).length > 1 && ids(split.ctaSlots).length > 1);
});

test('only the square ratio is accepted in v1 even though the schema names three', () => {
  assert.deepEqual(checkBriefAgainstFamily(briefFor('split-composition'), layoutRegistry, '1:1').ok, true);
  assert.ok(checkBriefAgainstFamily(briefFor('split-composition'), layoutRegistry, '9:16').problems.some((p) => p.kind === 'unsupported_ratio'));
});

test('a family can be switched off per tenant by id, and the rest stay', () => {
  const left = enabledFamilies(layoutRegistry, { disabled: ['full-bleed-editorial'] });
  assert.ok(!left.some((f) => f.id === 'full-bleed-editorial'));
  assert.equal(left.length, 5);
  assert.equal(enabledFamilies(layoutRegistry, {}).length, 6);
  assert.deepEqual(kinds(briefFor('full-bleed-editorial'), left), ['unknown_layout']);
});

test('the safest family cannot be switched off, so a fallback always exists', () => {
  const left = enabledFamilies(layoutRegistry, { disabled: ['typography-hero'] });
  assert.ok(left.some((f) => f.id === 'typography-hero'));
});
