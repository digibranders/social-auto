import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildHybridPrompt, captureHybrid, categorize, composeHybridHtml, CTA_ZONE, hybridTextCheck, LOGO_ZONE, measurePlainness, MIN_PLAIN_SHARE, rejectionReasons, zoneWarnings } from './ai-poster-hybrid.ts';
import { chromePath } from './platform.ts';
import { pngSize } from './chrome-render.ts';
import { readFile } from 'node:fs/promises';

const real = { skip: existsSync(chromePath(process.env, process.platform)) ? false : 'Chrome is not installed' };
const colors = { background: '#FFFEF5', ink: '#292929', accent: '#FF5542' };

test('the hybrid prompt asks for the headline only, leaves two plain areas and forbids a logo, name, link or button', () => {
  const prompt = buildHybridPrompt({ headline: 'From goals and audience to a website', fact: 'We translate goals into a website.', colors });
  assert.match(prompt, /HEADLINE: "From goals and audience to a website"/);
  assert.match(prompt, /Apart from those exact words, draw no other text and no logo, brand name, web address, button, call to action or small print/);
  assert.match(prompt, /top-left corner \(about 26% of the width and 17% of the height\)/);
  assert.match(prompt, /strip along the bottom \(about 14% of the height, full width\)/);
  assert.doesNotMatch(prompt, /SUPPORTING LINE/);
  assert.match(buildHybridPrompt({ headline: 'H', subline: 'S', fact: 'f', colors }), /SUPPORTING LINE: "S"/);
  assert.doesNotMatch(prompt, /attached|wordmark/i, 'the model is not asked to draw or copy the mark');
});

test('the text rule: the headline and nothing else, so a brand name, link or invented line on the poster is a rejection', () => {
  const expected = { headline: 'From goals and audience to a website' };
  const clean = hybridTextCheck(expected, ['From goals and audience to a website']);
  assert.deepEqual(rejectionReasons({ text: clean, plain: { logo: 0.97, cta: 0.95 } }, expected), []);
  const branded = hybridTextCheck(expected, ['From goals and audience to a website', 'Digibranders', 'digibranders.com']);
  const reasons = rejectionReasons({ text: branded, plain: { logo: 0.97, cta: 0.95 } }, expected);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? '', /digibranders/);
  const wrong = hybridTextCheck(expected, ['From goal and audiance to a website']);
  assert.ok(rejectionReasons({ text: wrong, plain: { logo: 1, cta: 1 } }, expected).some((r) => /not the approved headline/.test(r)));
  const noSubline = hybridTextCheck({ ...expected, subline: 'Built for you' }, ['From goals and audience to a website']);
  assert.ok(rejectionReasons({ text: noSubline, plain: { logo: 1, cta: 1 } }, { subline: 'Built for you' }).some((r) => /supporting line/.test(r)));
});

test('a corner or strip that is not plain is a diagnostic warning, not a rejection; the vision review of the finished poster decides', () => {
  const expected = { headline: 'H' };
  const text = hybridTextCheck(expected, ['H']);
  assert.deepEqual(rejectionReasons({ text, plain: { logo: 0.4, cta: 0.4 } }, expected), []);
  const warnings = zoneWarnings({ logo: 0.6, cta: MIN_PLAIN_SHARE - 0.01 });
  assert.equal(warnings.length, 2);
  assert.match(warnings.join(' '), /corner kept for the mark is 60% one colour/);
  assert.match(warnings.join(' '), /strip kept for the button is 89% one colour/);
  assert.deepEqual(zoneWarnings({ logo: 1, cta: 0.95 }), []);
  assert.match(zoneWarnings(undefined).join(' '), /could not be measured/);
});

test('rejections are sorted into the pilot categories so the first-attempt failure rate can be counted', () => {
  const text = hybridTextCheck({ headline: 'Book a call' }, ['Book a cal', 'Digibranders']);
  const reasons = rejectionReasons({ text, plain: { logo: 1, cta: 1 } }, { headline: 'Book a call' });
  assert.deepEqual(categorize({ textReasons: reasons, defects: [], warnings: [] }).sort(), ['extra_text', 'headline']);
  assert.deepEqual(categorize({ textReasons: [], defects: [{ code: 'cta_covers_subject' }, { code: 'picture_misleading' }, { code: 'dead_space' }], warnings: ['the corner kept for the mark is 60% one colour'] }).sort(), ['compositing', 'composition', 'relevance', 'reserved_area']);
  assert.deepEqual(categorize({ textReasons: [], defects: [], warnings: ['x'] }), [], 'a warning alone rejects nothing');
});

test('the composed page puts the real mark on a plate (dark for a pale mark, light otherwise) and the call to action at the bottom, and escapes its text', () => {
  const base = { imagePath: '/tmp/poster.jpg', colors: { ink: '#292929', accent: '#FF5542' }, cta: { label: 'Explore our services', host: 'digibranders.com' } };
  const pale = composeHybridHtml({ ...base, mark: { path: '/tmp/icon.png', kind: 'icon', tone: { pale: 0.9, dark: 0.0 } } });
  assert.match(pale, /data-slot="mark" data-kind="icon"[^>]*background:#14161C/);
  assert.match(pale, /height:84px/);
  const dark = composeHybridHtml({ ...base, mark: { path: '/tmp/logo.svg', kind: 'logo', tone: { pale: 0.0, dark: 0.9 } } });
  assert.match(dark, /background:#FFFFFF/);
  assert.match(dark, /height:64px/);
  assert.match(pale, /file:\/\/\/tmp\/poster\.jpg/);
  assert.match(pale, /left:44px;bottom:44px/);
  assert.match(pale, /Explore our services<br>digibranders\.com/, 'a long label and link are stacked on two lines');
  const short = composeHybridHtml({ ...base, cta: { label: 'Book a demo', host: 'a.io' }, mark: { path: '/tmp/icon.png', kind: 'icon', tone: null } });
  assert.match(short, /Book a demo a\.io/);
  const hostile = composeHybridHtml({ ...base, cta: { label: '<script>x()</script>', host: 'a.io' }, mark: { path: '/tmp/icon.png', kind: 'icon', tone: null } });
  assert.doesNotMatch(hostile, /<script>x/);
  assert.doesNotMatch(composeHybridHtml({ imagePath: '/tmp/p.jpg', colors: base.colors, mark: { path: '/tmp/i.png', kind: 'icon', tone: null } }), /data-slot="cta"/);
});

test('real Chrome: a plain corner and strip measure as plain, and one with an object in it does not', real, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zones-'));
  try {
    const plain = join(dir, 'plain.svg');
    await writeFile(plain, '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="#FFFEF5"/><rect x="300" y="300" width="500" height="400" fill="#FF5542"/></svg>');
    const busy = join(dir, 'busy.svg');
    await writeFile(busy, '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="#FFFEF5"/><rect x="20" y="20" width="200" height="130" fill="#111111"/><rect x="100" y="880" width="700" height="100" fill="#FF5542"/></svg>');
    const shares = await measurePlainness(plain, [LOGO_ZONE, CTA_ZONE]);
    assert.ok(shares && shares[0]! >= MIN_PLAIN_SHARE && shares[1]! >= MIN_PLAIN_SHARE, JSON.stringify(shares));
    const dirty = await measurePlainness(busy, [LOGO_ZONE, CTA_ZONE]);
    assert.ok(dirty && dirty[0]! < MIN_PLAIN_SHARE && dirty[1]! < MIN_PLAIN_SHARE, JSON.stringify(dirty));
    assert.equal(await measurePlainness(join(dir, 'missing.png'), [LOGO_ZONE]), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('real Chrome: the composed hybrid poster is captured at exactly 1080 x 1080', real, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hybrid-'));
  try {
    const art = join(dir, 'art.svg');
    await writeFile(art, '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="#FFFEF5"/></svg>');
    const mark = join(dir, 'mark.svg');
    await writeFile(mark, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#FF5542"/></svg>');
    const out = join(dir, 'out.png');
    await captureHybrid({ imagePath: art, mark: { path: mark, kind: 'icon', tone: null }, cta: { label: 'Explore our services', host: 'digibranders.com' }, colors: { ink: '#292929', accent: '#FF5542' } }, out);
    assert.deepEqual(pngSize(await readFile(out)), { width: 1080, height: 1080 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
