import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parseArtBrief, type ArtBrief } from './art-brief.ts';
import type { RenderCandidate } from './art-resolve.ts';
import { chromeVersion, measureHtml, pngSize } from './chrome-render.ts';
import { composePoster, type PosterBrand, type PosterCopy } from './compose.ts';
import { extractReport, judgeReport } from './fit-report.ts';
import { chromePath } from './platform.ts';
import { renderPoster, type RenderInput } from './render-poster.ts';
import { systemFont, type ResolvedFont } from './typography.ts';

const haveChrome = existsSync(chromePath(process.env, process.platform));
const real = { skip: haveChrome ? false : 'Chrome is not installed' };

const colors = { ink: '#14213D', accent: '#FCA311', background: '#FFFFFF', tile: '#F2F2F2' };
const brand: PosterBrand = { name: 'Acme', colors, identityLine: 'Project tracking for small teams', cta: { label: 'Book a demo', host: 'acme.example' } };
const font = systemFont('Inter');
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const hero = { role: 'hero', medium: 'illustration', subject: 'a board', action: 'glowing', scene: 'a workspace', composition: 'close', mood: 'calm', paletteUse: 'balanced' };
const brief = (layout: string, textZone: string, picture: Record<string, unknown>, over: Record<string, unknown> = {}): ArtBrief =>
  parseArtBrief({ layout, hierarchy: 'headline-first', headlineScale: 'large', alignment: 'start', textZone, picture, logoSlot: 'top-left', identitySlot: 'under-logo', ctaSlot: 'top-right', ...over }, 'p');
const candidate = (b: ArtBrief): RenderCandidate => ({
  optionId: `${b.layout}:${b.textZone}`, brief: b,
  ...(b.picture.role === 'none' ? {} : { imagePrompt: 'a prompt' }),
  record: { layout: b.layout, hierarchy: b.hierarchy, textZone: b.textZone, pictureRole: b.picture.role },
});

const measureOf = async (b: ArtBrief, copy: PosterCopy, over: { brand?: PosterBrand; font?: ResolvedFont; pictureUrl?: string } = {}) => {
  const composed = composePoster({ brief: b, copy, brand: over.brand ?? brand, font: over.font ?? font, mode: { kind: 'measure' }, ...(over.pictureUrl ? { pictureUrl: over.pictureUrl } : {}) });
  const report = extractReport(await measureHtml(composed.html));
  return { report, composed };
};

const SHORT: PosterCopy = { headline: 'Keep every |project| visible', subline: 'Acme shows where work stands' };

test('real Chrome: a short headline gets a large size inside its range and everything fits', real, async () => {
  const { report, composed } = await measureOf(brief('typography-hero', 'center', { role: 'none' }, { headlineScale: 'xl' }), SHORT);
  const judged = judgeReport(report, { slots: ['headline'], images: 0, contrast: composed.contrast });
  assert.equal(judged.ok, true, JSON.stringify(judged.hard));
  assert.ok((judged.solved['headline'] ?? 0) >= 120, `headline solved at ${judged.solved['headline']}`);
  assert.ok((judged.solved['headline'] ?? 999) <= 160);
  assert.deepEqual(report.collisions, []);
});

test('real Chrome: a long headline is reflowed to a smaller size or fails, and is never truncated', real, async () => {
  const long = { headline: 'Everything your whole team needs to keep every single |project| moving without delay', subline: 'Acme' };
  const { report } = await measureOf(brief('typography-hero', 'center', { role: 'none' }, { headlineScale: 'xl' }), long);
  const headline = report.elements.find((e) => e.slot === 'headline');
  assert.ok(headline);
  assert.ok(headline.fontSize < 160, 'reflowed below the maximum');
  if (headline.fits) assert.ok(headline.lines <= headline.maxLines);
});

test('real Chrome: text that cannot fit even at the smallest size reports an overflow', real, async () => {
  const huge = { headline: 'x'.repeat(40) + ' ' + 'word '.repeat(60), subline: 'Acme' };
  const { report, composed } = await measureOf(brief('split-composition', 'left', hero), huge);
  const judged = judgeReport(report, { slots: ['headline'], images: 0, contrast: composed.contrast });
  assert.equal(judged.ok, false);
  assert.ok(judged.hard.some((i) => i.code === 'text_overflow' && i.slot === 'headline'));
});

test('real Chrome: a long unbreakable word is wrapped or fails explicitly, never overflows silently', real, async () => {
  const word = { headline: 'Supercalifragilisticexpialidocious'.repeat(2), subline: 'Acme' };
  const { report, composed } = await measureOf(brief('typography-hero', 'center', { role: 'none' }), word);
  const judged = judgeReport(report, { slots: ['headline'], images: 0, contrast: composed.contrast });
  const headline = report.elements.find((e) => e.slot === 'headline');
  assert.ok(headline);
  if (judged.ok) assert.ok(headline.rect.x + headline.rect.w <= 1080 - 32 + 1);
  else assert.ok(judged.hard.some((i) => i.code === 'text_overflow'));
});

test('real Chrome: multiple accent spans are counted as lines correctly', real, async () => {
  const spans = { headline: '|Plan| less, |ship| more, |worry| never', subline: 'Acme' };
  const { report } = await measureOf(brief('typography-hero', 'center', { role: 'none' }), spans);
  const headline = report.elements.find((e) => e.slot === 'headline');
  assert.ok(headline && headline.lines >= 1 && headline.lines <= headline.maxLines);
});

test('real Chrome: a long brand name and CTA are fitted without overlap or clipping', real, async () => {
  const wide: PosterBrand = { ...brand, name: 'The Extraordinarily Long Brand Name Incorporated International', cta: { label: 'Schedule a complimentary consultation today', host: 'extraordinarily-long-domain-name.example' }, logoHtml: undefined as never };
  const { report, composed } = await measureOf(brief('typography-hero', 'center', { role: 'none' }), SHORT, { brand: wide });
  const judged = judgeReport(report, { slots: ['headline'], images: 0, contrast: composed.contrast });
  for (const e of report.elements.filter((x) => x.slot === 'logo' || x.slot === 'cta')) assert.ok(e.rect.w <= e.slotW + 1, `${e.slot} width`);
  assert.ok(!judged.hard.some((i) => i.code === 'collision'), JSON.stringify(judged.hard));
});

test('real Chrome: Hindi and Arabic headlines are measured with their own direction and no missing glyphs on this machine', real, async () => {
  const hindi = await measureOf(brief('typography-hero', 'center', { role: 'none' }), { headline: 'हर |प्रोजेक्ट| को साफ़ दिखाइए', subline: 'टीम के लिए' });
  assert.deepEqual(hindi.report.missingGlyphs, []);
  const arabic = await measureOf(brief('typography-hero', 'center', { role: 'none' }), { headline: 'اجعل كل |مشروع| واضحا', subline: 'للفريق' });
  assert.deepEqual(arabic.report.missingGlyphs, []);
  assert.match(arabic.composed.html, /data-slot="headline"[^>]*dir="rtl"/);
});

test('real Chrome: a character no font can draw is reported', real, async () => {
  const { report } = await measureOf(brief('typography-hero', 'center', { role: 'none' }), { headline: 'Keep \u{10FFFE} visible', subline: 'Acme' });
  assert.ok(report.missingGlyphs.length > 0);
});

test('real Chrome: a picture that fails to load fails the measurement', real, async () => {
  const { report, composed } = await measureOf(brief('split-composition', 'left', hero), SHORT, { pictureUrl: 'file:///nonexistent/picture.png' });
  assert.equal(judgeReport(report, { slots: ['headline'], images: 1, contrast: composed.contrast }).hard.some((i) => i.code === 'image_failed'), true);
});

test('real Chrome: the measuring page cannot reach the network', real, async () => {
  const { composed } = await measureOf(brief('typography-hero', 'center', { role: 'none' }), SHORT);
  assert.match(composed.html, /default-src 'none'/);
});

test('real Chrome: the six families all measure and render without hard failures on a short headline', real, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-test-'));
  try {
    const picture = join(dir, 'p.png');
    await writeFile(picture, PIXEL);
    const url = pathToFileURL(picture).href;
    const copy: PosterCopy = { ...SHORT, listItems: ['Review status', 'Track tasks', 'Check deadlines'], figure: '40%' };
    const set: Array<[ArtBrief, string | undefined]> = [
      [brief('typography-hero', 'center', { ...hero, role: 'texture', medium: 'abstract' }), url],
      [brief('split-composition', 'left', hero), url],
      [brief('full-bleed-editorial', 'bottom', hero), url],
      [brief('feature-spotlight', 'left', hero), url],
      [brief('structured-information', 'top', { role: 'none' }, { hierarchy: 'list-first' }), undefined],
      [brief('evidence-spotlight', 'center', { role: 'none' }, { hierarchy: 'figure-first' }), undefined],
    ];
    for (const [b, pictureUrl] of set) {
      const composed = composePoster({ brief: b, copy, brand, font, mode: { kind: 'measure' }, ...(pictureUrl ? { pictureUrl } : {}) });
      const judged = judgeReport(extractReport(await measureHtml(composed.html)), { slots: ['headline'], images: pictureUrl ? 1 : 0, contrast: composed.contrast });
      assert.equal(judged.ok, true, `${b.layout}: ${JSON.stringify(judged.hard)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function job(): Promise<{ dir: string; out: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'render-test-'));
  return { dir, out: join(dir, 'poster.png') };
}

test('real Chrome: a poster is measured, frozen and captured at exactly 1080x1080, with system fonts reported honestly', real, async () => {
  const { dir, out } = await job();
  try {
    const result = await renderPoster({ copy: SHORT, brand, font, candidates: [candidate(brief('typography-hero', 'center', { role: 'none' }))], outPng: out });
    assert.equal(result.status, 'capture_complete');
    assert.ok(result.warnings.some((w) => w.code === 'system_font'));
    assert.match(result.chromeVersion, /Chrome/);
    assert.deepEqual(pngSize(await readFile(out)), { width: 1080, height: 1080 });
    assert.ok(result.solved?.['headline']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real Chrome: repeating a render gives the same solved typography', real, async () => {
  const { dir, out } = await job();
  try {
    const run = (): Promise<unknown> => renderPoster({ copy: SHORT, brand, font, candidates: [candidate(brief('typography-hero', 'center', { role: 'none' }))], outPng: out }).then((r) => r.solved);
    assert.deepEqual(await run(), await run());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real Chrome: when the first candidate cannot fit, the next one renders, the record follows, and the picture is never requested for the failed one', real, async () => {
  const { dir, out } = await job();
  try {
    const tooLong: PosterCopy = { headline: 'Everything your whole team needs to keep every single project moving without delay at all', subline: 'Acme' };
    const first = candidate(brief('split-composition', 'left', hero));
    const second = candidate(brief('typography-hero', 'center', { role: 'none' }));
    let pictures = 0;
    const result = await renderPoster({ copy: tooLong, brand, font, candidates: [first, second], outPng: out, makePicture: async () => { pictures += 1; return undefined; } });
    assert.equal(result.attempts[0]?.ok, false, 'the first candidate fails measurement');
    assert.equal(result.optionId, second.optionId);
    assert.equal(result.record?.layout, 'typography-hero');
    assert.equal(pictures, 0, 'no picture was paid for');
    assert.equal(result.status, 'capture_complete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real Chrome: when every candidate fails, the post is render_failed, no picture is requested and no artifact is written', real, async () => {
  const { dir, out } = await job();
  try {
    const huge: PosterCopy = { headline: 'x'.repeat(60) + ' ' + 'word '.repeat(80), subline: 'Acme' };
    let pictures = 0;
    const result = await renderPoster({ copy: huge, brand, font, candidates: [candidate(brief('split-composition', 'left', hero)), candidate(brief('typography-hero', 'center', { role: 'none' }))], outPng: out, makePicture: async () => { pictures += 1; return 'file:///x'; } });
    assert.equal(result.status, 'render_failed');
    assert.equal(pictures, 0);
    await assert.rejects(stat(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real Chrome: the picture is made only for the candidate that passed, and a poster with a real picture renders', real, async () => {
  const { dir, out } = await job();
  try {
    const picture = join(dir, 'p.png');
    await writeFile(picture, PIXEL);
    const chosen: string[] = [];
    const result = await renderPoster({
      copy: SHORT, brand, font, candidates: [candidate(brief('split-composition', 'left', hero))], outPng: out,
      makePicture: async (c) => { chosen.push(c.optionId); return pathToFileURL(picture).href; },
    });
    assert.deepEqual(chosen, ['split-composition:left']);
    assert.equal(result.status, 'capture_complete');
    assert.deepEqual(pngSize(await readFile(out)), { width: 1080, height: 1080 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real Chrome: a picture that was not produced, or that will not load, fails the post without a poster', real, async () => {
  const { dir, out } = await job();
  try {
    const none = await renderPoster({ copy: SHORT, brand, font, candidates: [candidate(brief('split-composition', 'left', hero))], outPng: out, makePicture: async () => undefined });
    assert.equal(none.status, 'render_failed');
    const broken = await renderPoster({ copy: SHORT, brand, font, candidates: [candidate(brief('split-composition', 'left', hero))], outPng: out, makePicture: async () => 'file:///nonexistent/p.png' });
    assert.equal(broken.status, 'render_failed');
    await assert.rejects(stat(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a measurement report that is absent is a hard failure, never assumed success (no Chrome needed)', async () => {
  const input: RenderInput = {
    copy: SHORT, brand, font, candidates: [candidate(brief('typography-hero', 'center', { role: 'none' }))], outPng: join(tmpdir(), 'never.png'),
    chrome: { run: async (_file, args) => ({ stdout: args.includes('--version') ? 'Fake Chrome 1' : '<html></html>' }) },
  };
  const result = await renderPoster(input);
  assert.equal(result.status, 'render_failed');
  assert.match(result.attempts[0]?.issues[0]?.message ?? '', /no measurement report/);
});

test('Chrome version is recorded from the browser', real, async () => {
  assert.match(await chromeVersion(), /Chrome/);
});

test('real Chrome: a realistic identity line fits its slot on the first candidate, and one too long for any slot is dropped with a warning instead of failing the poster', real, async () => {
  const { dir, out } = await job();
  try {
    const realistic: PosterBrand = { ...brand, identityLine: 'An AI chat assistant that answers from your content and scores visitors.' };
    const fits = await renderPoster({ copy: SHORT, brand: realistic, font, candidates: [candidate(brief('split-composition', 'left', { role: 'none' }, {}))].map((c) => ({ ...c, brief: brief('typography-hero', 'center', { role: 'none' }) })), outPng: out });
    assert.notEqual(fits.status, 'render_failed', JSON.stringify(fits.attempts));
    assert.ok(!fits.warnings.some((w) => w.code === 'identity_omitted'), 'a normal identity line is kept');

    const tooLong: PosterBrand = { ...brand, identityLine: 'An AI chat assistant that answers questions from your own content, scores every visitor as they chat, hands the hot ones to your team and reports on all of it. '.repeat(3) };
    const dropped = await renderPoster({ copy: SHORT, brand: tooLong, font, candidates: [candidate(brief('typography-hero', 'center', { role: 'none' }))], outPng: out });
    assert.equal(dropped.status, 'capture_complete');
    assert.ok(dropped.warnings.some((w) => w.code === 'identity_omitted'));
    assert.deepEqual(pngSize(await readFile(out)), { width: 1080, height: 1080 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
