import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractReport, judgeReport, MeasurementError, type ElementReport, type RenderReport } from './fit-report.ts';

const element = (slot: string, over: Partial<ElementReport> = {}): ElementReport => ({
  slot, role: slot, layer: 'text', fontSize: 100, min: 72, max: 124, lines: 2, maxLines: 4, height: 200, slotH: 420, slotW: 952, fits: true, rect: { x: 64, y: 260, w: 800, h: 200 }, ...over,
});
const report = (over: Partial<RenderReport> = {}): RenderReport => ({
  done: true, errors: [], fontSource: 'local', fonts: { status: 'loaded', faces: [{ family: 'Inter', status: 'loaded' }] }, images: [], elements: [element('headline'), element('subline', { rect: { x: 64, y: 700, w: 500, h: 40 } })], collisions: [], outside: [], missingGlyphs: [], ...over,
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
