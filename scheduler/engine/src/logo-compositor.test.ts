import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrandingError, inspectLogoFile } from './branding.ts';
import { captureHtml } from './chrome-render.ts';
import { COMPOSITOR_RULES, placeLogo, readPage, verifyPlacement, type Box } from './logo-compositor.ts';

const STRIPES = 'repeating-linear-gradient(45deg,#222 0 6px,#ddd 6px 12px)';
const poster = (body: string): string => `<!doctype html><html><body style="margin:0;width:1080px;height:1080px;background:#e8e8ec;position:relative;overflow:hidden">${body}</body></html>`;
const logoSvg = (fill: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect x="0" y="30" width="400" height="40" rx="8" fill="${fill}"/><circle cx="50" cy="50" r="30" fill="${fill}"/></svg>`;

async function workspace(): Promise<{ dir: string; make: (name: string, html: string) => Promise<string>; logo: (name: string, svg: string) => string; done: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'logo-compositor-'));
  return {
    dir,
    make: async (name, html) => { const path = join(dir, name); await captureHtml(html, path); return path; },
    logo: (name, svg) => { const path = join(dir, name); writeFileSync(path, svg); return path; },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('a dark logo is placed in the quiet part of a poster, clear of the text, inside the margin, and the rest of the picture is untouched', async () => {
  const w = await workspace();
  try {
    // The left 700 pixels are busy; the right is plain. The headline sits in the busy part.
    const posterPath = await w.make('poster.png', poster(`<div style="position:absolute;left:0;top:0;width:700px;height:1080px;background:${STRIPES}"></div>`));
    const avoid: Box[] = [[100, 400, 600, 700]];
    const result = await placeLogo({ posterPath, logoPath: w.logo('logo.svg', logoSvg('#111111')), logoKind: 'wordmark', avoid, outPath: join(w.dir, 'out.jpg') });
    assert.equal(result.placed, true);
    if (!result.placed) return;
    assert.ok(result.logoRect[0] >= 690, `the logo went to the plain area, not onto the stripes (x = ${result.logoRect[0]})`);
    assert.equal(result.plateColor, null, 'a dark logo on a light plain area needs no plate');
    assert.ok(result.contrast >= COMPOSITOR_RULES.minContrastWordmark);
    assert.ok(result.score >= COMPOSITOR_RULES.minScore);
    assert.deepEqual([result.width, result.height], [1080, 1080]);
    assert.ok(result.logoRect[2] >= 1080 * 0.12 - 2 && result.logoRect[2] <= 1080 * 0.3 + 2, 'its size is within the allowed share of the width');
    assert.equal(result.logoSha256, inspectLogoFile(join(w.dir, 'logo.svg')).sha256, 'the logo file is the one recorded');
    assert.equal(result.outputSha256.length, 64);
    const written = inspectLogoFile(join(w.dir, 'out.jpg'));
    assert.deepEqual([written.kind, written.width, written.height], ['jpeg', 1080, 1080]);
  } finally {
    w.done();
  }
});

const opaqueLogo = (fill: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="${fill}"/><rect x="20" y="30" width="360" height="40" fill="#bbbbbb"/></svg>`;

test('a pale logo with a transparent background on a pale picture gets a thin dark halo that follows its outline, and nothing else changes', async () => {
  const w = await workspace();
  try {
    const posterPath = await w.make('poster.png', poster(''));
    const result = await placeLogo({ posterPath, logoPath: w.logo('pale.svg', logoSvg('#fafafa')), logoKind: 'wordmark', avoid: [], outPath: join(w.dir, 'out.jpg') });
    assert.equal(result.placed, true);
    if (!result.placed) return;
    assert.equal(result.treatment, 'halo');
    assert.equal(result.plateRect, null, 'a halo adds no box');
    assert.equal(result.haloColor, 'rgb(20,20,20)', 'a pale logo gets a dark halo');
    assert.ok(result.contrast >= COMPOSITOR_RULES.minContrastWordmark, 'the contrast is the logo against its halo');
  } finally {
    w.done();
  }
});

test('a dark logo on a dark picture gets a light halo, and a dark logo on a light picture gets nothing', async () => {
  const w = await workspace();
  try {
    const dark = await w.make('dark.png', `<!doctype html><html><body style="margin:0;width:1080px;height:1080px;background:#0b1020"></body></html>`);
    const onDark = await placeLogo({ posterPath: dark, logoPath: w.logo('logo.svg', logoSvg('#111111')), logoKind: 'wordmark', avoid: [], outPath: join(w.dir, 'dark-out.jpg') });
    assert.equal(onDark.placed, true);
    if (onDark.placed) assert.deepEqual([onDark.treatment, onDark.haloColor], ['halo', 'rgb(255,255,255)']);
    const light = await w.make('light.png', poster(''));
    const onLight = await placeLogo({ posterPath: light, logoPath: join(w.dir, 'logo.svg'), logoKind: 'wordmark', avoid: [], outPath: join(w.dir, 'light-out.jpg') });
    assert.equal(onLight.placed, true);
    if (onLight.placed) assert.deepEqual([onLight.treatment, onLight.haloColor, onLight.plateRect], ['none', null, null]);
  } finally {
    w.done();
  }
});

test('a logo without a transparent background gets no halo around its box: a tone-matched plate is the only help', async () => {
  const w = await workspace();
  try {
    const dark = await w.make('dark.png', `<!doctype html><html><body style="margin:0;width:1080px;height:1080px;background:#0b1020"></body></html>`);
    const result = await placeLogo({ posterPath: dark, logoPath: w.logo('boxed.svg', opaqueLogo('#111111')), logoKind: 'wordmark', avoid: [], outPath: join(w.dir, 'out.jpg') });
    if (result.placed) {
      assert.notEqual(result.treatment, 'halo');
      if (result.treatment === 'plate') assert.ok(result.plateColor !== null && result.plateRect !== null, 'a plate has a colour and a place');
    } else {
      assert.equal(result.reason, 'NO_SAFE_PLACEMENT');
    }
  } finally {
    w.done();
  }
});

const corner = (box: string): string => `<div style="position:absolute;${box};background:${STRIPES}"></div>`;

test('the logo goes to the top corner with more room, the bottom only when no top corner will do, and nowhere when no corner is quiet', async () => {
  const w = await workspace();
  try {
    const logo = w.logo('logo.svg', logoSvg('#111111'));
    const run = async (name: string, html: string): Promise<{ x: number; y: number } | null> => {
      const posterPath = await w.make(`${name}.png`, poster(html));
      const result = await placeLogo({ posterPath, logoPath: logo, logoKind: 'wordmark', avoid: [], outPath: join(w.dir, `${name}-out.jpg`) });
      return result.placed ? { x: result.logoRect[0], y: result.logoRect[1] } : null;
    };
    const topLeftBusy = await run('a', corner('left:0;top:0;width:540px;height:300px'));
    assert.ok(topLeftBusy && topLeftBusy.y < 300 && topLeftBusy.x > 540, 'with the top-left busy, the top-right is used');
    const topRightBusy = await run('b', corner('right:0;top:0;width:540px;height:300px'));
    assert.ok(topRightBusy && topRightBusy.y < 300 && topRightBusy.x < 540, 'with the top-right busy, the top-left is used');
    const topBusy = await run('c', corner('left:0;top:0;width:1080px;height:400px'));
    assert.ok(topBusy && topBusy.y > 650, 'with the whole top busy, a bottom corner is used');
    const noCorner = await run('d', corner('left:0;top:0;width:1080px;height:400px') + corner('left:0;bottom:0;width:1080px;height:400px'));
    assert.equal(noCorner, null, 'with every corner busy it refuses, even though the middle is plain');
    const inMiddle = await run('e', '');
    assert.ok(inMiddle && (inMiddle.y < 320 || inMiddle.y > 700), 'on a plain poster the logo is still in a corner zone, not the middle');
  } finally {
    w.done();
  }
});

test('a poster with no quiet place is not given a logo, and nothing is written', async () => {
  const w = await workspace();
  try {
    const busy = await w.make('busy.png', poster(`<div style="position:absolute;inset:0;background:${STRIPES}"></div>`));
    const refused = await placeLogo({ posterPath: busy, logoPath: w.logo('logo.svg', logoSvg('#111111')), logoKind: 'wordmark', avoid: [], outPath: join(w.dir, 'busy-out.jpg') });
    assert.equal(refused.placed, false);
    if (refused.placed) return;
    assert.equal(refused.reason, 'NO_SAFE_PLACEMENT');
    assert.equal(existsSync(join(w.dir, 'busy-out.jpg')), false, 'no picture is written when no place was safe');

    // A plain poster whose every plain place is taken by text is refused too.
    const plain = await w.make('plain.png', poster(''));
    const covered = await placeLogo({ posterPath: plain, logoPath: join(w.dir, 'logo.svg'), logoKind: 'wordmark', avoid: [[0, 0, 1080, 1080]], outPath: join(w.dir, 'covered-out.jpg') });
    assert.equal(covered.placed, false);
    if (!covered.placed) assert.equal(covered.reason, 'NO_SAFE_PLACEMENT');
    assert.equal(existsSync(join(w.dir, 'covered-out.jpg')), false);
  } finally {
    w.done();
  }
});

test('a logo file that is not the one that was checked and kept is refused, and an unsafe SVG is never drawn', async () => {
  const w = await workspace();
  try {
    const posterPath = await w.make('poster.png', poster(''));
    const logoPath = w.logo('logo.svg', logoSvg('#111111'));
    const changed = await placeLogo({ posterPath, logoPath, logoKind: 'wordmark', avoid: [], outPath: join(w.dir, 'out.jpg'), expectedLogoSha256: 'f'.repeat(64) });
    assert.deepEqual([changed.placed, changed.placed ? '' : changed.reason], [false, 'LOGO_CHANGED']);
    assert.equal(existsSync(join(w.dir, 'out.jpg')), false);
    const unsafe = w.logo('unsafe.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><script>alert(1)</script><rect width="400" height="100"/></svg>');
    await assert.rejects(() => placeLogo({ posterPath, logoPath: unsafe, logoKind: 'wordmark', avoid: [], outPath: join(w.dir, 'unsafe-out.jpg') }), (e: unknown) => e instanceof BrandingError && e.code === 'UNSAFE_SVG');
  } finally {
    w.done();
  }
});

test('a symbol is placed smaller than a wordmark, within its own share of the width', async () => {
  const w = await workspace();
  try {
    const posterPath = await w.make('poster.png', poster(''));
    const result = await placeLogo({ posterPath, logoPath: w.logo('mark.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#111"/></svg>'), logoKind: 'symbol', avoid: [], outPath: join(w.dir, 'out.jpg') });
    assert.equal(result.placed, true);
    if (!result.placed) return;
    assert.ok(result.logoRect[2] >= 1080 * COMPOSITOR_RULES.symbolWidth[0] - 2 && result.logoRect[2] <= 1080 * COMPOSITOR_RULES.symbolWidth[1] + 2);
    assert.equal(result.logoRect[2], result.logoRect[3], 'a square mark stays square');
  } finally {
    w.done();
  }
});

const good = { ok: true, W: 1080, H: 1080, logoRect: [800, 60, 200, 50] as [number, number, number, number], plateRect: null, contrast: 12, outsideChanged: 0 };
const info = { kind: 'png' as const, width: 1080, height: 1080, bytes: 1, sha256: 'x', transparent: false };

test('the checks the code repeats whatever the page said: margin, text, size, contrast and an untouched picture', () => {
  assert.equal(verifyPlacement(good, info, [[100, 400, 600, 700]], 'wordmark'), null);
  assert.match(verifyPlacement({ ...good, logoRect: [10, 60, 200, 50] }, info, [], 'wordmark') ?? '', /outside the margin/);
  assert.match(verifyPlacement({ ...good, logoRect: [900, 60, 200, 50] }, info, [], 'wordmark') ?? '', /outside the margin/, 'the right edge counts too');
  assert.match(verifyPlacement(good, info, [[700, 40, 900, 100]], 'wordmark') ?? '', /too close to text/);
  assert.equal(verifyPlacement(good, info, [[700, 40, 770, 100]], 'wordmark'), null, 'text clear of the logo by more than the clearance is fine');
  assert.match(verifyPlacement({ ...good, logoRect: [800, 60, 40, 10] }, info, [], 'wordmark') ?? '', /not the allowed size/);
  assert.match(verifyPlacement({ ...good, logoRect: [500, 60, 200, 400] }, info, [], 'wordmark') ?? '', /too tall/);
  assert.match(verifyPlacement({ ...good, contrast: 2 }, info, [], 'wordmark') ?? '', /does not stand out enough/);
  assert.equal(verifyPlacement({ ...good, contrast: 3.2, logoRect: [800, 60, 100, 100] }, info, [], 'symbol'), null, 'a symbol needs less contrast');
  assert.match(verifyPlacement({ ...good, outsideChanged: 4 }, info, [], 'wordmark') ?? '', /changed outside the logo/);
  assert.match(verifyPlacement({ ...good, W: 1024 }, info, [], 'wordmark') ?? '', /size changed/);
  const plate = { ...good, plateRect: [788, 48, 224, 74] as [number, number, number, number] };
  assert.equal(verifyPlacement(plate, info, [], 'wordmark'), null);
  assert.match(verifyPlacement({ ...plate, plateRect: [788, 20, 224, 74] }, info, [], 'wordmark') ?? '', /outside the margin/, 'the plate is held to the margin, not only the logo');
});

test('what the page wrote is read back, escaped characters included, and silence or nonsense is nothing', () => {
  const dom = `<html><body><pre id="result">{&quot;ok&quot;:true,&quot;score&quot;:0.9}</pre><textarea id="image">data:image/jpeg;base64,AAAA</textarea></body></html>`;
  assert.deepEqual(readPage(dom), { result: { ok: true, score: 0.9 }, image: 'data:image/jpeg;base64,AAAA' });
  assert.equal(readPage('<pre id="result"></pre>'), null);
  assert.equal(readPage('<pre id="result">not json</pre>'), null);
  assert.equal(readPage('<html></html>'), null);
  assert.equal(readPage('<pre id="result">{"ok":false,"reason":"NO_SAFE_PLACEMENT"}</pre><textarea id="image">javascript:alert(1)</textarea>')?.image, null, 'only a JPEG data address is accepted as the picture');
});
