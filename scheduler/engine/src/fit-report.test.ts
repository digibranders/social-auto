import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractReport, judgeReport, MeasurementError, type ElementReport, type RenderReport } from './fit-report.ts';

const element = (slot: string, over: Partial<ElementReport> = {}): ElementReport => ({
  slot, role: slot, layer: 'text', fontSize: 100, min: 72, max: 124, lines: 2, maxLines: 4, height: 200, slotH: 420, slotW: 952, fits: true, rect: { x: 64, y: 260, w: 800, h: 200 }, ...over,
});
const report = (over: Partial<RenderReport> = {}): RenderReport => ({
  done: true, errors: [], fontSource: 'local', fonts: { status: 'loaded', faces: [{ family: 'Inter', status: 'loaded' }] }, images: [], elements: [element('headline'), element('subline', { rect: { x: 64, y: 700, w: 500, h: 40 } }), element('identity', { role: 'identity', layer: 'brand', rect: { x: 64, y: 980, w: 600, h: 40 } })], collisions: [], outside: [], missingGlyphs: [], ...over,
});
const wrap = (r: unknown): string => `<html><head><script id="fit-report" type="application/json">${JSON.stringify(r)}</script></head></html>`;
const expectations = { slots: ['headline'], images: 0, contrast: [] };

test('a well-formed report is extracted from the dumped page', () => {
  assert.deepEqual(extractReport(wrap(report())), report());
});

test('a missing, malformed or wrongly shaped report is a measurement error, never assumed success', () => {
  assert.throws(() => extractReport('<html></html>'), MeasurementError);
  assert.throws(() => extractReport('<script id="fit-report" type="application/json">{not json</script>'), MeasurementError);
  assert.throws(() => extractReport(wrap({ done: true })), MeasurementError);
  assert.throws(() => extractReport(wrap({ ...report(), elements: [{ slot: 'headline' }] })), /malformed element/);
});

test('a clean report with local fonts passes with no issues', () => {
  const judged = judgeReport(report(), expectations);
  assert.equal(judged.ok, true);
  assert.deepEqual(judged.hard, []);
  assert.deepEqual(judged.warnings, []);
  assert.equal(judged.solved['headline'], 100);
});

test('system fonts are a warning, not a failure', () => {
  const judged = judgeReport(report({ fontSource: 'system', fonts: { status: 'loaded', faces: [] } }), expectations);
  assert.equal(judged.ok, true);
  assert.equal(judged.warnings[0]?.code, 'system_font');
});

test('a local font that did not load, or an unknown source, is a hard failure', () => {
  assert.equal(judgeReport(report({ fonts: { status: 'loaded', faces: [{ family: 'Inter', status: 'error' }] } }), expectations).hard[0]?.code, 'font_not_loaded');
  assert.equal(judgeReport(report({ fonts: { status: 'loaded', faces: [] } }), expectations).hard[0]?.code, 'font_not_loaded');
  assert.equal(judgeReport(report({ fontSource: 'cdn' }), expectations).hard[0]?.code, 'font_not_loaded');
});

test('an unfinished measurement or page errors fail', () => {
  assert.equal(judgeReport(report({ done: false }), expectations).hard[0]?.code, 'measurement_incomplete');
  assert.equal(judgeReport(report({ errors: ['boom'] }), expectations).hard[0]?.code, 'measurement_incomplete');
});

test('text that does not fit even at its smallest size fails, and a missing headline fails', () => {
  const overflow = judgeReport(report({ elements: [element('headline', { fits: false, fontSize: 72, lines: 6, height: 600 })] }), expectations);
  assert.equal(overflow.hard[0]?.code, 'text_overflow');
  assert.match(overflow.hard[0]?.message ?? '', /72px/);
  assert.equal(judgeReport(report({ elements: [element('subline')] }), expectations).hard[0]?.code, 'missing_slot');
});

test('collisions, content outside the margins, missing glyphs and failed pictures are hard failures', () => {
  assert.equal(judgeReport(report({ collisions: [['headline', 'logo']] }), expectations).hard[0]?.code, 'collision');
  assert.equal(judgeReport(report({ outside: ['cta'] }), expectations).hard[0]?.code, 'outside_margin');
  assert.equal(judgeReport(report({ missingGlyphs: ['ऄ'] }), expectations).hard[0]?.code, 'missing_glyphs');
  assert.equal(judgeReport(report({ images: [{ slot: 'picture', ok: false }] }), { ...expectations, images: 1 }).hard[0]?.code, 'image_failed');
  assert.equal(judgeReport(report({ images: [] }), { ...expectations, images: 1 }).hard[0]?.code, 'image_failed');
});

test('a failing contrast check is a hard failure', () => {
  const judged = judgeReport(report(), { ...expectations, contrast: [{ slot: 'headline', ratio: 3.1, target: 4.5, ok: false }] });
  assert.equal(judged.hard[0]?.code, 'contrast');
});

import { contentReach } from './fit-report.ts';

test('content that stops well above the bottom edge, with no picture or brand element below it, is a warning and never a failure', () => {
  const short = report({ elements: [element('headline'), element('subline', { rect: { x: 64, y: 700, w: 500, h: 40 } })] });
  const judged = judgeReport(short, expectations);
  assert.equal(judged.ok, true);
  assert.deepEqual(judged.hard, []);
  assert.deepEqual(judged.warnings.map((w) => w.code), ['possible_unbalanced_composition']);
  assert.match(judged.warnings[0]?.message ?? '', /not for a cropped picture subject/);
  assert.ok(contentReach(short) < 0.85);
});

test('a picture that fills the lower part, a brand element near the bottom, or a lower threshold removes the warning', () => {
  const short = report({ elements: [element('headline'), element('subline', { rect: { x: 64, y: 700, w: 500, h: 40 } })] });
  assert.deepEqual(judgeReport(short, { ...expectations, pictureRects: [{ y: 780, h: 250 }] }).warnings, []);
  assert.deepEqual(judgeReport(short, { ...expectations, minContentReach: 0.6 }).warnings, []);
  assert.deepEqual(judgeReport(report(), expectations).warnings, []);
});

test('text laid over the picture\'s subject is a hard failure; a brush against its loose box, brand elements and a subject elsewhere are not', () => {
  const over = judgeReport(report(), { ...expectations, subjectRect: { x: 200, y: 300, w: 400, h: 300 } });
  assert.deepEqual(over.hard.map((i) => i.code), ['text_over_subject']);
  assert.equal(over.hard[0]?.slot, 'headline');
  const brush = judgeReport(report(), { ...expectations, subjectRect: { x: 800, y: 430, w: 200, h: 200 } });
  assert.deepEqual(brush.hard, [], 'only 30 px of the text box is touched, which is a brush, not a collision');
  const elsewhere = judgeReport(report(), { ...expectations, subjectRect: { x: 700, y: 600, w: 300, h: 300 } });
  assert.deepEqual(elsewhere.hard, []);
  const brand = judgeReport(report(), { ...expectations, subjectRect: { x: 64, y: 960, w: 500, h: 80 } });
  assert.deepEqual(brand.hard, [], 'a brand element (identity, CTA, logo) over a picture has its own backing and is not the headline');
  assert.deepEqual(judgeReport(report(), expectations).hard, [], 'no subject known, nothing to check');
});
