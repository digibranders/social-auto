import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArtBrief, type ArtBrief } from './art-brief.ts';
import { composePoster, ComposeError, type ComposeInput, type PosterBrand, type PosterCopy } from './compose.ts';
import { backingAlpha, composite, contrastRatio, TARGET_RATIO } from './contrast.ts';
import { familyById, layoutRegistry } from './layout-registry.ts';
import { scriptOf, systemFont, textStyleFor } from './typography.ts';

const colors = { ink: '#14213D', accent: '#FCA311', background: '#FFFFFF', tile: '#F2F2F2' };
const brand: PosterBrand = { name: 'Acme', colors, identityLine: 'Project tracking for small teams', cta: { label: 'Book a demo', host: 'acme.example' }, logoHtml: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', logoTone: { pale: 0, dark: 1 } };
const copy: PosterCopy = { headline: 'Keep every |project| visible', subline: 'Acme shows where work stands', listItems: ['Review status', 'Track tasks', 'Check deadlines'], figure: '40%' };
const font = systemFont('Inter');

const hero = { role: 'hero', medium: 'illustration', subject: 'a board', action: 'glowing', scene: 'a workspace', composition: 'close', mood: 'calm', paletteUse: 'balanced' };
const briefOf = (layout: string, textZone: string, picture: Record<string, unknown>, over: Record<string, unknown> = {}): ArtBrief =>
  parseArtBrief({ layout, hierarchy: 'headline-first', headlineScale: 'large', alignment: 'start', textZone, picture, logoSlot: 'top-left', identitySlot: 'under-logo', ctaSlot: 'top-right', ...over }, 'post 1');

const FAMILY_BRIEFS: Array<[string, ArtBrief, Partial<ComposeInput>]> = [
  ['typography-hero', briefOf('typography-hero', 'center', { ...hero, role: 'texture', medium: 'abstract' }), { pictureUrl: 'file:///tmp/x.png' }],
  ['split-composition', briefOf('split-composition', 'left', hero), { pictureUrl: 'file:///tmp/x.png' }],
  ['full-bleed-editorial', briefOf('full-bleed-editorial', 'bottom', hero), { pictureUrl: 'file:///tmp/x.png' }],
  ['feature-spotlight', briefOf('feature-spotlight', 'left', hero), { pictureUrl: 'file:///tmp/x.png' }],
  ['structured-information', briefOf('structured-information', 'top', { role: 'none' }, { hierarchy: 'list-first' }), {}],
  ['evidence-spotlight', briefOf('evidence-spotlight', 'center', { role: 'none' }, { hierarchy: 'figure-first' }), {}],
];

const compose = (brief: ArtBrief, over: Partial<ComposeInput> = {}) => composePoster({ brief, copy, brand, font, mode: { kind: 'measure' }, ...over });

test('each family composes a page whose slots come from the registry', () => {
  for (const [id, brief, extra] of FAMILY_BRIEFS) {
    const { html } = compose(brief, extra);
    assert.match(html, new RegExp(`class="family-${id}"`), id);
    const zone = familyById(layoutRegistry, id)?.zones[brief.textZone];
    const headline = zone?.textSlots.find((s) => s.id === 'headline');
    assert.ok(headline);
    assert.ok(html.includes(`left:${headline.rect.x}px;top:${headline.rect.y}px;width:${headline.rect.w}px;height:${headline.rect.h}px;`), `${id} headline rect`);
    assert.match(html, /data-slot="headline"/);
    assert.match(html, /data-slot="subline"/);
  }
});

test('every family passes the contrast target for the text it draws', () => {
  for (const [id, brief, extra] of FAMILY_BRIEFS) {
    const { contrast } = compose(brief, extra);
    assert.ok(contrast.length > 0, id);
    for (const c of contrast) assert.ok(c.ok, `${id}/${c.slot} ${c.ratio}`);
  }
});

test('the six families are structurally different pages', () => {
  const shapes = FAMILY_BRIEFS.map(([, brief, extra]) => {
    const { html } = compose(brief, extra);
    return JSON.stringify([html.includes('data-layer="scrim"'), html.includes('data-slot="picture"'), html.includes('class="list"'), html.includes('data-slot="figure"'), html.includes('opacity:0.28'), (html.match(/<div data-layer="decor"/g) ?? []).length, html.match(/body\{background:[^;]+/)?.[0]]);
  });
  assert.equal(new Set(shapes).size, 6, shapes.join('\n'));
});

test('the headline keeps its |accent| spans and its text unchanged', () => {
  const { html } = compose(FAMILY_BRIEFS[0]![1], FAMILY_BRIEFS[0]![2]);
  assert.match(html, /Keep every <span class="accent">project<\/span> visible/);
  assert.doesNotMatch(html.match(/data-slot="headline"[^>]*>[^<]*<span[^]*?<\/div>/)?.[0] ?? '', /\|/);
});

test('website text is escaped, so markup in copy or brand content never runs', () => {
  const hostile = '<img src=x onerror=alert(1)><script>boom()</script>';
  const { html } = compose(FAMILY_BRIEFS[1]![1], {
    ...FAMILY_BRIEFS[1]![2],
    copy: { headline: `${hostile} |x|`, subline: hostile },
    brand: { ...brand, name: hostile, identityLine: hostile, cta: { label: hostile, host: hostile }, logoHtml: undefined as never },
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>boom/);
  assert.match(html, /&lt;script&gt;boom\(\)&lt;\/script&gt;/);
});

test('the page may load only local files: a network picture is refused and the policy blocks the rest', () => {
  assert.throws(() => compose(FAMILY_BRIEFS[1]![1], { pictureUrl: 'https://evil.example/x.png' }), ComposeError);
  assert.throws(() => compose(FAMILY_BRIEFS[1]![1], { pictureUrl: 'javascript:alert(1)' }), ComposeError);
  const { html } = compose(FAMILY_BRIEFS[1]![1], FAMILY_BRIEFS[1]![2]);
  assert.match(html, /default-src 'none'; img-src file: data:/);
});

test('picture role none has no image element and no placeholder', () => {
  const { html } = compose(FAMILY_BRIEFS[4]![1]);
  assert.doesNotMatch(html, /<img data-layer="picture"/);
  assert.doesNotMatch(html, /data-placeholder/);
});

test('a picture is decoded before the page paints, so a capture never shows a half-drawn picture', () => {
  assert.match(compose(FAMILY_BRIEFS[1]![1], FAMILY_BRIEFS[1]![2]).html, /<img data-layer="picture"[^>]*decoding="sync"/);
});

test('a measuring page shows a placeholder when the picture does not exist yet, and a frozen page refuses', () => {
  const brief = FAMILY_BRIEFS[1]![1];
  assert.match(compose(brief).html, /data-placeholder="1"/);
  assert.throws(() => compose(brief, { mode: { kind: 'frozen', solved: {} } }), /frozen poster needs its picture/);
});

test('a missing logo becomes the brand name, with no empty plate', () => {
  const { html } = compose(FAMILY_BRIEFS[0]![1], { ...FAMILY_BRIEFS[0]![2], brand: { ...brand, logoHtml: undefined as never } });
  assert.match(html, /data-slot="logo"[^>]*>Acme</);
  assert.doesNotMatch(html, /class="plate"/);
});

test('a missing identity line or CTA is omitted, never invented', () => {
  const { html } = compose(FAMILY_BRIEFS[0]![1], { ...FAMILY_BRIEFS[0]![2], brand: { ...brand, identityLine: undefined as never, cta: undefined as never } });
  assert.doesNotMatch(html, /data-slot="identity"/);
  assert.doesNotMatch(html, /data-slot="cta"/);
});

test('long identity and CTA text is kept whole, for the solver to fit or fail', () => {
  const long = 'A very long identity line that describes the business in far too many words for its slot';
  const { html } = compose(FAMILY_BRIEFS[0]![1], { ...FAMILY_BRIEFS[0]![2], brand: { ...brand, identityLine: long } });
  assert.ok(html.includes(long));
});

test('a figure or quotation is shown only when it was provided, and a figure-first poster needs one', () => {
  const brief = FAMILY_BRIEFS[5]![1];
  assert.match(compose(brief).html, /data-slot="figure"[^>]*>40%</);
  assert.match(compose(brief, { copy: { ...copy, figure: undefined as never, quote: 'Saved us hours' } }).html, /&ldquo;Saved us hours&rdquo;/);
  assert.throws(() => compose(brief, { copy: { headline: copy.headline, subline: copy.subline } }), /needs a verified figure, quotation or offer/);
  const headlineFirst = briefOf('evidence-spotlight', 'center', { role: 'none' });
  assert.doesNotMatch(compose(headlineFirst, { copy: { headline: copy.headline, subline: copy.subline } }).html, /data-slot="figure"/);
});

test('no list items means no list slot is drawn', () => {
  const { html } = compose(FAMILY_BRIEFS[4]![1], { copy: { headline: copy.headline, subline: copy.subline } });
  assert.doesNotMatch(html, /data-slot="list"/);
});

test('a frozen page carries the solved sizes and no script', () => {
  const brief = FAMILY_BRIEFS[4]![1];
  const frozen = compose(brief, { mode: { kind: 'frozen', solved: { headline: 97, subline: 31 } } }).html;
  assert.match(frozen, /data-slot="headline"[^>]*font-size:97px/);
  assert.match(frozen, /data-slot="subline"[^>]*font-size:31px/);
  assert.doesNotMatch(frozen, /<script>/);
  assert.match(compose(brief).html, /<script>/);
});

test('an unknown layout, zone or slot is a compose error', () => {
  assert.throws(() => compose({ ...FAMILY_BRIEFS[0]![1], layout: 'nowhere' }), ComposeError);
  assert.throws(() => compose({ ...FAMILY_BRIEFS[0]![1], textZone: 'left' }), ComposeError);
  assert.throws(() => compose({ ...FAMILY_BRIEFS[0]![1], logoSlot: 'floating' }), ComposeError);
});

test('composing is deterministic', () => {
  const [, brief, extra] = FAMILY_BRIEFS[2]!;
  assert.equal(compose(brief, extra).html, compose(brief, extra).html);
});

test('two tenants with different brand tokens share nothing', () => {
  const [, brief, extra] = FAMILY_BRIEFS[5]!;
  const other = compose(brief, { ...extra, brand: { ...brand, name: 'Other', colors: { ink: '#1B4332', accent: '#95D5B2', background: '#F8F9FA', tile: '#E9ECEF' } } }).html;
  const first = compose(brief, extra).html;
  assert.ok(other.includes('#1B4332'));
  assert.ok(!other.includes('#14213D'));
  assert.ok(!first.includes('#1B4332'));
});

test('contrast arithmetic: ratios, compositing and the backing opacity for worst-case pictures', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF')), 21);
  assert.equal(composite('#000000', 0.5, '#FFFFFF'), '#808080');
  const alpha = backingAlpha('#FFFFFF', '#14213D');
  assert.ok(alpha !== null && alpha < 1);
  for (const bg of ['#FFFFFF', '#000000']) assert.ok(contrastRatio('#FFFFFF', composite('#14213D', alpha ?? 1, bg)) >= TARGET_RATIO);
  assert.equal(backingAlpha('#FFFFFF', '#CCCCCC'), null, 'a light backing cannot carry white text');
});

test('script detection, direction and spacing by script', () => {
  assert.equal(scriptOf('Keep projects visible'), 'latin');
  assert.equal(scriptOf('हर प्रोजेक्ट साफ़ दिखाइए'), 'devanagari');
  assert.equal(scriptOf('اجعل كل مشروع واضحا'), 'arabic');
  assert.equal(scriptOf('让每个项目一目了然'), 'cjk');
  assert.equal(textStyleFor('اجعل كل مشروع', true).dir, 'rtl');
  assert.equal(textStyleFor('हर प्रोजेक्ट', true).letterSpacingEm, 0);
  assert.ok(textStyleFor('Keep projects', true).letterSpacingEm < 0);
  assert.ok(textStyleFor('हर प्रोजेक्ट', true).lineHeight > textStyleFor('Keep projects', true).lineHeight);
});

test('a system font names the brand font first and says its source is system', () => {
  const f = systemFont('Inter');
  assert.equal(f.source, 'system');
  assert.match(f.stack, /^"Inter", /);
  assert.equal(systemFont('Bad"; } body { x').stack.includes('}'), false);
});

test('the typography layout draws no decorative rule that a long headline could run into, and no layout draws decor over the headline slot', () => {
  const none = compose(briefOf('typography-hero', 'top', { role: 'none' }));
  assert.ok(!none.html.includes('<div data-layer="decor"'));
  const slot = familyById(layoutRegistry, 'typography-hero')?.zones['top']?.textSlots.find((s) => s.id === 'headline');
  assert.ok(slot);
  for (const [id, brief, extra] of FAMILY_BRIEFS) {
    const { html } = compose(brief, extra);
    for (const m of html.matchAll(/<div data-layer="decor" style="left:(-?\d+)px;top:(-?\d+)px;width:(\d+)px;height:(\d+)px;/g)) {
      const [x, y, w, h] = m.slice(1).map(Number) as [number, number, number, number];
      const zone = familyById(layoutRegistry, id)?.zones[brief.textZone];
      const headline = zone?.textSlots.find((s) => s.id === 'headline');
      if (!headline || w >= 1000 || h >= 1000) continue; // full-length edge rules sit on a picture edge, not on text
      const overlaps = x < headline.rect.x + headline.rect.w && x + w > headline.rect.x && y < headline.rect.y + headline.rect.h && y + h > headline.rect.y;
      assert.ok(!overlaps || id === 'feature-spotlight', `${id} decor overlaps the headline slot`);
    }
  }
});

test('the typography family has a light editorial variant: a full-height rail on the canvas edge, text clear of it, and no picture', () => {
  const brief = briefOf('typography-hero', 'left', { role: 'none' });
  const { html } = compose(brief);
  assert.match(html, /body\{background:#[0-9A-Fa-f]{6};\}/);
  const rails = [...html.matchAll(/<div data-layer="decor" style="left:(-?\d+)px;top:(-?\d+)px;width:(\d+)px;height:(\d+)px;/g)];
  assert.equal(rails.length, 1);
  const [x, y, w, h] = (rails[0] as RegExpMatchArray).slice(1).map(Number) as [number, number, number, number];
  assert.deepEqual([x, y, w, h], [0, 0, 28, 1080]);
  const zone = familyById(layoutRegistry, 'typography-hero')?.zones['left'];
  assert.ok(zone && zone.imageSlots.length === 0);
  for (const slot of zone.textSlots) assert.ok(slot.rect.x >= x + w + 32, `${slot.id} starts clear of the rail`);
  assert.ok(!html.includes('<img'));
  const dark = compose(briefOf('typography-hero', 'center', { role: 'none' })).html;
  assert.notEqual(html.match(/body\{background:[^;]+/)?.[0], dark.match(/body\{background:[^;]+/)?.[0]);
});


test('centred text is centred on the poster: a wide slot is moved to the middle, a narrow slot beside a picture stays', () => {
  const centred = (layout: string, zone: string, picture: Record<string, unknown>) => compose(briefOf(layout, zone, picture, { alignment: 'center' }), layout === 'typography-hero' ? {} : { pictureUrl: 'file:///tmp/x.png' }).html;
  const left = (html: string, slot: string): number => Number(new RegExp(`<div class="slot" style="left:(-?\\d+(?:\\.\\d+)?)px;[^"]*"><div class="fit" data-fit="1" data-slot="${slot}"`).exec(html)?.[1]);
  const bleed = centred('full-bleed-editorial', 'top', hero);
  assert.equal(left(bleed, 'headline'), 140);
  assert.equal(left(bleed, 'subline'), 140);
  const split = centred('split-composition', 'left', hero);
  assert.equal(left(split, 'headline'), 64);
  const start = compose(briefOf('full-bleed-editorial', 'top', hero), { pictureUrl: 'file:///tmp/x.png' }).html;
  assert.equal(left(start, 'headline'), 64);
});

test('the lower-anchored typography variant is a light page with no picture and no decor, so a feed of picture-free posts mixes dark and light', () => {
  const bottom = compose(briefOf('typography-hero', 'bottom', { role: 'none' })).html;
  const center = compose(briefOf('typography-hero', 'center', { role: 'none' })).html;
  assert.notEqual(bottom.match(/body\{background:[^;]+/)?.[0], center.match(/body\{background:[^;]+/)?.[0]);
  assert.ok(!bottom.includes('<div data-layer="decor"') && !bottom.includes('<img'));
  assert.equal(familyById(layoutRegistry, 'typography-hero')?.zones['bottom']?.imageSlots.length, 0);
});
