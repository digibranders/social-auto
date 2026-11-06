/**
 * Puts a client's own logo on a finished poster. The picture model draws the whole poster and is told to leave a quiet area; this finds the best such area in
 * the finished picture and draws the logo there, exactly as the website has it: in a top corner when one is quiet, a bottom corner when no top one is, and
 * nowhere when no corner is. The logo file is never redrawn, recoloured, stretched or given effects; the only addition is, when the picture under the logo
 * would make it hard to read, a thin halo that follows the logo's own outline (for a logo with a transparent background) or, failing that, a small plate
 * matched to the tone of the picture around it. Everything outside the logo (and its plate) is left as it was.
 *
 * It runs in the headless Chrome the engine already uses (canvas does the pixel work), with the checks that matter repeated here in code:
 * the logo is inside the margin, clear of every piece of text the readers found, large and contrasty enough, and the saved picture is the size it was.
 * Nothing here spends money. A poster with no safe place for the logo is NOT given one: the caller decides what happens then.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { inspectLogoFile, type LogoFileInfo } from './branding.ts';
import { measureHtml, type ChromeDeps } from './chrome-render.ts';

/** A box in the poster's pixels: left, top, right, bottom. */
export type Box = readonly [number, number, number, number];

export const COMPOSITOR_RULES = {
  /** The logo stays this far from the picture's edge. */
  margin: 40,
  /** The room around the logo that is looked at (and, with a plate, covered). */
  padding: 10,
  plateRadius: 8,
  /** The logo goes in a corner: the top 25% of the picture first, the bottom 25% only when no top corner will do, and within this share of the width from a side. */
  cornerHeightShare: 0.25,
  cornerWidthShare: 0.18,
  /** Text found by the readers is kept this far from the logo. */
  textClearance: 24,
  /** How wide the logo may be, as shares of the picture's width. */
  wordmarkWidth: [0.14, 0.24] as const,
  symbolWidth: [0.06, 0.11] as const,
  /** The width a logo is happiest at, as a share of the picture's width. */
  idealWordmark: 0.18,
  idealSymbol: 0.085,
  /** The tallest the logo may be, as a share of the picture's height, and the shortest it may be, in pixels. */
  maxHeightShare: 0.13,
  minWordmarkHeight: 28,
  /** Contrast (WCAG ratio) the logo needs against what is behind it, with or without a plate. */
  minContrastWordmark: 4.5,
  minContrastSymbol: 3,
  /** The lowest score a place may have to be used. Provisional: tuned on real posters. */
  minScore: 0.55,
  /** The plate is tone-matched to the picture around it; when that cannot give enough contrast it is near white or near black. */
  plateLight: '#ffffff',
  plateDark: '#10141e',
  gridStep: 16,
  /** The halo: a thin outline that follows the logo's own shape, drawn behind the logo. Light for a dark logo, dark for a pale one; never a brand colour. */
  haloRadius: [2, 3, 4] as const,
  haloLight: [255, 255, 255] as const,
  haloDark: [20, 20, 20] as const,
  haloOpacity: 0.92,
} as const;

export interface PlacementInput {
  posterPath: string;
  logoPath: string;
  /** `wordmark`: the whole logo with its name; `symbol`: a mark alone, which is placed smaller. */
  logoKind: 'wordmark' | 'symbol';
  /** Boxes of the text the readers found on the poster, in its pixels. The logo never touches them. */
  avoid: readonly Box[];
  /** Where the finished picture is written (JPEG). */
  outPath: string;
  /** The hash the logo file must still have; a changed file is refused. */
  expectedLogoSha256?: string;
  minScore?: number;
}

export type PlacementRefusal = 'NO_SAFE_PLACEMENT' | 'LOGO_CHANGED' | 'LOGO_NOT_DRAWN' | 'CHECK_FAILED';

export interface Placement {
  placed: true;
  /** The logo's own rectangle (x, y, width, height), in the poster's pixels. */
  logoRect: [number, number, number, number];
  /** The plate behind it (x, y, width, height), or null when none was needed. */
  plateRect: [number, number, number, number] | null;
  plateColor: string | null;
  /** What was added behind the logo: nothing, a halo that follows its outline, or a plate. */
  treatment: 'none' | 'halo' | 'plate';
  haloColor: string | null;
  score: number;
  /** The contrast ratio the logo has against what is behind it (the plate, when there is one). */
  contrast: number;
  logoSha256: string;
  outputSha256: string;
  width: number;
  height: number;
  /** How many places were looked at, and the best three scores, for the record. */
  considered: number;
  bestScores: number[];
}

export interface PlacementFailure {
  placed: false;
  reason: PlacementRefusal;
  detail: string;
  /** The best score found when no place was good enough. */
  bestScore?: number;
}

const MIME: Readonly<Record<string, string>> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** The page that does the looking and drawing. Its answer is written into #result (JSON) and #image (the finished picture as a data address). */
const PAGE_SCRIPT = String.raw`
const P = JSON.parse(document.getElementById('params').textContent);
const out = (r) => { document.getElementById('result').textContent = JSON.stringify(r); };
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ratioOf = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const load = (src) => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('image')); i.src = src; });

(async () => {
  try {
    const poster = await load(P.poster);
    const W = poster.naturalWidth, H = poster.naturalHeight;
    const canvas = document.getElementById('c');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(poster, 0, 0);
    const base = ctx.getImageData(0, 0, W, H);
    const px = base.data;

    // Planes: luminance (for variance and edges) and relative luminance (for contrast), as integral images so any rectangle is measured at once.
    const stride = W + 1;
    const size = stride * (H + 1);
    const sumL = new Float64Array(size), sumL2 = new Float64Array(size), sumY = new Float64Array(size), sumE = new Float64Array(size);
    const L = new Float32Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) L[i] = 0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, p = i * 4;
        let e = 0;
        if (x > 0 && y > 0 && x < W - 1 && y < H - 1) {
          const gx = -L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1] + L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1];
          const gy = -L[i - W - 1] - 2 * L[i - W] - L[i - W + 1] + L[i + W - 1] + 2 * L[i + W] + L[i + W + 1];
          e = Math.hypot(gx, gy) > 80 ? 1 : 0;
        }
        const yRel = 0.2126 * lin(px[p]) + 0.7152 * lin(px[p + 1]) + 0.0722 * lin(px[p + 2]);
        const k = (y + 1) * stride + (x + 1), up = y * stride + (x + 1), left = (y + 1) * stride + x, diag = y * stride + x;
        sumL[k] = L[i] + sumL[up] + sumL[left] - sumL[diag];
        sumL2[k] = L[i] * L[i] + sumL2[up] + sumL2[left] - sumL2[diag];
        sumY[k] = yRel + sumY[up] + sumY[left] - sumY[diag];
        sumE[k] = e + sumE[up] + sumE[left] - sumE[diag];
      }
    }
    const area = (I, x, y, w, h) => I[(y + h) * stride + (x + w)] - I[y * stride + (x + w)] - I[(y + h) * stride + x] + I[y * stride + x];

    // The logo: how light or dark it is, from its visible pixels.
    const logo = await load(P.logo);
    const aspect = P.logoWidth / P.logoHeight;
    const tone = document.createElement('canvas');
    const tw = 256, th = Math.max(8, Math.round(256 / aspect));
    tone.width = tw; tone.height = th;
    const tctx = tone.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(logo, 0, 0, tw, th);
    const tp = tctx.getImageData(0, 0, tw, th).data;
    let weight = 0, logoY = 0, clear = 0;
    for (let i = 0; i < tp.length; i += 4) {
      const a = tp[i + 3] / 255;
      if (a < 0.1) { clear++; continue; }
      logoY += a * (0.2126 * lin(tp[i]) + 0.7152 * lin(tp[i + 1]) + 0.0722 * lin(tp[i + 2]));
      weight += a;
    }
    if (weight < 20) { out({ ok: false, reason: 'LOGO_NOT_DRAWN' }); return; }
    logoY /= weight;
    // A halo follows the logo's own outline, so it needs a logo with a real transparent background (not a picture in a box).
    const hasAlpha = clear / (tp.length / 4) >= 0.05;
    const lightLogo = logoY > 0.18;
    const haloRgb = lightLogo ? P.rules.haloDark : P.rules.haloLight;
    const haloY = 0.2126 * lin(haloRgb[0]) + 0.7152 * lin(haloRgb[1]) + 0.0722 * lin(haloRgb[2]);
    const haloRatio = ratioOf(logoY, haloY);

    const wordmark = P.kind === 'wordmark';
    const needRatio = wordmark ? P.rules.minContrastWordmark : P.rules.minContrastSymbol;
    const [shareLow, shareHigh] = wordmark ? P.rules.wordmarkWidth : P.rules.symbolWidth;
    const shares = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => shareLow + (shareHigh - shareLow) * t);
    const ideal = wordmark ? P.rules.idealWordmark : P.rules.idealSymbol;
    const pad = P.rules.padding, margin = P.rules.margin, step = P.rules.gridStep;
    const avoid = P.avoid.map((b) => [b[0] - P.rules.textClearance, b[1] - P.rules.textClearance, b[2] + P.rules.textClearance, b[3] + P.rules.textClearance]);
    const hits = (x, y, w, h) => avoid.some((b) => x < b[2] && x + w > b[0] && y < b[3] && y + h > b[1]);
    const gap = (x, y, w, h) => {
      let best = Infinity;
      for (const b of P.avoid) {
        const dx = Math.max(0, b[0] - (x + w), x - b[2]);
        const dy = Math.max(0, b[1] - (y + h), y - b[3]);
        best = Math.min(best, Math.hypot(dx, dy));
      }
      return best;
    };

    let considered = 0;
    const found = [];
    for (const share of shares) {
      const lw = Math.round(W * share), lh = Math.round(lw / aspect);
      if (lh > H * P.rules.maxHeightShare) continue;
      if (wordmark && lh < P.rules.minWordmarkHeight) continue;
      const pw = lw + 2 * pad, ph = lh + 2 * pad;
      for (let y = margin; y + ph <= H - margin; y += step) {
        for (let x = margin; x + pw <= W - margin; x += step) {
          if (hits(x, y, pw, ph)) continue;
          // A logo belongs in a corner, like a signature: a top corner as the space allows, a bottom one only when no top one passes.
          if (Math.min(x - margin, W - margin - (x + pw)) > P.rules.cornerWidthShare * W) continue;
          const top = y - margin <= P.rules.cornerHeightShare * H;
          const bottom = H - margin - (y + ph) <= P.rules.cornerHeightShare * H;
          if (!top && !bottom) continue;
          considered++;
          const n = pw * ph;
          const mean = area(sumL, x, y, pw, ph) / n;
          const sd = Math.sqrt(Math.max(0, area(sumL2, x, y, pw, ph) / n - mean * mean));
          const edges = area(sumE, x, y, pw, ph) / n;
          if (edges > 0.18 || sd > 70) continue;
          const bgY = area(sumY, x, y, pw, ph) / n;
          const direct = ratioOf(logoY, bgY);
          let plate = null, halo = false, ratio = direct;
          if (direct < needRatio && hasAlpha && haloRatio >= needRatio) {
            // The halo is the first help: it follows the logo and adds no box to the picture.
            halo = true; ratio = haloRatio;
          } else if (direct < needRatio) {
            const onLight = ratioOf(logoY, 1), onDark = ratioOf(logoY, 0.0075);
            if (Math.max(onLight, onDark) < needRatio) continue;
            plate = onLight >= onDark ? P.rules.plateLight : P.rules.plateDark;
            ratio = Math.max(onLight, onDark);
          }
          const F = 1 - clamp01(sd / 48);
          const E = 1 - clamp01(edges / 0.12);
          const g = gap(x, y, pw, ph);
          const D = Number.isFinite(g) ? clamp01(g / 160) : 1;
          // A plate is a last resort: a spot where the logo shows up on its own is preferred to one that needs a plate behind it.
          const C = clamp01(ratio / 7) * (plate ? 0.6 : halo ? 0.85 : 1);
          // A logo beside the picture's edge sits like a signature; one floating in the middle of the artwork does not. This is a preference, not a rule.
          const nearest = Math.min(x, y, W - (x + pw), H - (y + ph));
          const B = 1 - clamp01(nearest / (0.28 * Math.min(W, H)));
          // And it should not sit hard against clutter: the ring just outside it is looked at too.
          const rx = Math.max(0, x - 40), ry = Math.max(0, y - 40), rw = Math.min(W, x + pw + 40) - rx, rh = Math.min(H, y + ph + 40) - ry;
          const ringEdges = (area(sumE, rx, ry, rw, rh) - area(sumE, x, y, pw, ph)) / Math.max(1, rw * rh - pw * ph);
          const R = 1 - clamp01(ringEdges / 0.15);
          // The logo should be easy to see but never louder than the headline: a size near the ideal is preferred, not the smallest or the largest.
          const S = clamp01(1 - Math.abs(share - ideal) / (wordmark ? 0.12 : 0.04));
          const score = 0.24 * F + 0.24 * E + 0.12 * D + 0.14 * C + 0.12 * B + 0.06 * R + 0.08 * S;
          found.push({ x, y, pw, ph, lw, lh, plate, halo, ratio, score, top });
        }
      }
    }
    // The top corners are used if any of them is good enough; the bottom ones only then.
    const usable = (f) => f.score >= P.minScore;
    const pool = found.some((f) => f.top && usable(f)) ? found.filter((f) => f.top) : found;
    pool.sort((a, b) => b.score - a.score);
    const best = pool[0];
    const bestScores = pool.slice(0, 3).map((f) => Math.round(f.score * 1000) / 1000);
    if (!best || best.score < P.minScore) { out({ ok: false, reason: 'NO_SAFE_PLACEMENT', considered, bestScore: best ? Math.round(best.score * 1000) / 1000 : 0, bestScores }); return; }

    if (best.plate) {
      // Matched to the picture around the logo: the average colour there, darkened for a light logo and lightened for a dark one. If that does not give the
      // logo enough contrast, the plain near-white or near-black plate is used instead.
      const sample = ctx.getImageData(best.x, best.y, best.pw, best.ph).data;
      let sr = 0, sg = 0, sb = 0;
      const count = sample.length / 4;
      for (let i = 0; i < sample.length; i += 4) { sr += sample[i]; sg += sample[i + 1]; sb += sample[i + 2]; }
      sr /= count; sg /= count; sb /= count;
      const mix = lightLogo ? 0.78 : 0.86, target = lightLogo ? 0 : 255;
      const tr = Math.round(sr + (target - sr) * mix), tg = Math.round(sg + (target - sg) * mix), tb = Math.round(sb + (target - sb) * mix);
      const plateY = 0.2126 * lin(tr) + 0.7152 * lin(tg) + 0.0722 * lin(tb);
      const matched = ratioOf(logoY, plateY);
      if (matched >= needRatio) { best.plate = 'rgb(' + tr + ',' + tg + ',' + tb + ')'; best.ratio = matched; }
      ctx.fillStyle = best.plate;
      const r = P.rules.plateRadius, x = best.x, y = best.y, w = best.pw, h = best.ph;
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath(); ctx.fill();
    }
    if (best.halo) {
      // The logo's silhouette, thickened by a few pixels and softened a little, in a neutral colour, then the untouched logo on top of it.
      const radius = best.lw < 140 ? P.rules.haloRadius[0] : best.lw > 220 ? P.rules.haloRadius[2] : P.rules.haloRadius[1];
      const layer = document.createElement('canvas');
      layer.width = best.pw; layer.height = best.ph;
      const lctx = layer.getContext('2d');
      for (let a = 0; a < 32; a++) {
        const angle = (a / 32) * Math.PI * 2;
        for (const reach of [radius * 0.5, radius]) lctx.drawImage(logo, pad + Math.cos(angle) * reach, pad + Math.sin(angle) * reach, best.lw, best.lh);
      }
      lctx.globalCompositeOperation = 'source-in';
      lctx.fillStyle = 'rgb(' + haloRgb[0] + ',' + haloRgb[1] + ',' + haloRgb[2] + ')';
      lctx.fillRect(0, 0, best.pw, best.ph);
      ctx.save();
      ctx.filter = 'blur(0.8px)';
      ctx.globalAlpha = P.rules.haloOpacity;
      ctx.drawImage(layer, best.x, best.y);
      ctx.restore();
    }
    ctx.drawImage(logo, best.x + pad, best.y + pad, best.lw, best.lh);

    // Everything outside the plate (or the logo and its edge, when there is no plate) must still be exactly the poster.
    const after = ctx.getImageData(0, 0, W, H).data;
    const boxed = best.plate || best.halo;
    const x0 = boxed ? best.x : best.x + pad - 1, y0 = boxed ? best.y : best.y + pad - 1;
    const x1 = boxed ? best.x + best.pw : best.x + pad + best.lw + 1, y1 = boxed ? best.y + best.ph : best.y + pad + best.lh + 1;
    let changed = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const p = (y * W + x) * 4;
      if (after[p] !== px[p] || after[p + 1] !== px[p + 1] || after[p + 2] !== px[p + 2]) changed++;
    }
    document.getElementById('image').textContent = canvas.toDataURL('image/jpeg', 0.95);
    out({ ok: true, W, H, logoRect: [best.x + pad, best.y + pad, best.lw, best.lh], plateRect: best.plate ? [best.x, best.y, best.pw, best.ph] : null, plateColor: best.plate, treatment: best.plate ? 'plate' : best.halo ? 'halo' : 'none', haloRect: best.halo ? [best.x, best.y, best.pw, best.ph] : null, haloColor: best.halo ? 'rgb(' + haloRgb[0] + ',' + haloRgb[1] + ',' + haloRgb[2] + ')' : null, score: Math.round(best.score * 1000) / 1000, contrast: Math.round(best.ratio * 100) / 100, outsideChanged: changed, considered, bestScores });
  } catch (error) {
    out({ ok: false, reason: 'LOGO_NOT_DRAWN', detail: String(error && error.message || error) });
  }
})();
`;

/** The whole page, with its inputs. The poster and logo travel as data addresses so nothing is read from anywhere else. */
export function compositorHtml(params: Record<string, unknown>): string {
  return `<!doctype html><html><body><canvas id="c"></canvas><pre id="result"></pre><textarea id="image"></textarea><script type="application/json" id="params">${JSON.stringify(params)}</script><script>${PAGE_SCRIPT}</script></body></html>`;
}

const unescapeText = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

interface PageResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  W?: number;
  H?: number;
  logoRect?: [number, number, number, number];
  plateRect?: [number, number, number, number] | null;
  plateColor?: string | null;
  treatment?: 'none' | 'halo' | 'plate';
  haloRect?: [number, number, number, number] | null;
  haloColor?: string | null;
  score?: number;
  bestScore?: number;
  bestScores?: number[];
  contrast?: number;
  outsideChanged?: number;
  considered?: number;
}

/** What the page wrote, or null when it wrote nothing readable. */
export function readPage(dom: string): { result: PageResult; image: string | null } | null {
  const result = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)?.[1];
  if (!result || result.trim() === '') return null;
  try {
    const image = /<textarea id="image">([\s\S]*?)<\/textarea>/.exec(dom)?.[1]?.trim() ?? '';
    return { result: JSON.parse(unescapeText(result)) as PageResult, image: image.startsWith('data:image/jpeg;base64,') ? image : null };
  } catch {
    return null;
  }
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** The rectangle a logo and its plate may not leave, and what the code insists on whatever the page said. */
export function verifyPlacement(page: PageResult, poster: LogoFileInfo, avoid: readonly Box[], logoKind: 'wordmark' | 'symbol'): string | null {
  const R = COMPOSITOR_RULES;
  const logo = page.logoRect;
  if (!logo || page.W !== poster.width || page.H !== poster.height) return 'the picture size changed';
  const outer = page.plateRect ?? page.haloRect ?? [logo[0] - 1, logo[1] - 1, logo[2] + 2, logo[3] + 2];
  if (outer[0] < R.margin || outer[1] < R.margin || outer[0] + outer[2] > poster.width - R.margin || outer[1] + outer[3] > poster.height - R.margin) return 'the logo is outside the margin';
  for (const b of avoid) {
    if (outer[0] < b[2] + R.textClearance && outer[0] + outer[2] > b[0] - R.textClearance && outer[1] < b[3] + R.textClearance && outer[1] + outer[3] > b[1] - R.textClearance) return 'the logo is too close to text';
  }
  const [low, high] = logoKind === 'wordmark' ? R.wordmarkWidth : R.symbolWidth;
  if (logo[2] < poster.width * low - 2 || logo[2] > poster.width * high + 2) return 'the logo is not the allowed size';
  if (logo[3] > poster.height * R.maxHeightShare + 2) return 'the logo is too tall';
  if (logoKind === 'wordmark' && logo[3] < R.minWordmarkHeight - 1) return 'the logo is too short to read';
  const need = logoKind === 'wordmark' ? R.minContrastWordmark : R.minContrastSymbol;
  if (page.contrast === undefined || page.contrast < need) return 'the logo does not stand out enough';
  if (page.outsideChanged !== 0) return 'the picture changed outside the logo';
  return null;
}

/**
 * Looks for the best quiet place on the poster for the logo and draws it there. Returns the placement, or the reason none was made; it writes the finished
 * picture only when a placement passed every check.
 */
export async function placeLogo(input: PlacementInput, deps: ChromeDeps = {}): Promise<Placement | PlacementFailure> {
  const logoInfo = inspectLogoFile(input.logoPath);
  if (input.expectedLogoSha256 && logoInfo.sha256 !== input.expectedLogoSha256) return { placed: false, reason: 'LOGO_CHANGED', detail: 'the logo file is not the one that was checked and kept' };
  const posterInfo = inspectLogoFile(input.posterPath);
  if (posterInfo.kind !== 'jpeg' && posterInfo.kind !== 'png') return { placed: false, reason: 'CHECK_FAILED', detail: 'the poster is not a JPEG or PNG picture' };
  const [posterBytes, logoBytes] = await Promise.all([readFile(input.posterPath), readFile(input.logoPath)]);
  const logoMime = MIME[extname(input.logoPath).toLowerCase()] ?? (logoInfo.kind === 'svg' ? 'image/svg+xml' : `image/${logoInfo.kind}`);
  const html = compositorHtml({
    poster: `data:${posterInfo.kind === 'png' ? 'image/png' : 'image/jpeg'};base64,${posterBytes.toString('base64')}`,
    logo: `data:${logoMime};base64,${logoBytes.toString('base64')}`,
    logoWidth: logoInfo.width,
    logoHeight: logoInfo.height,
    kind: input.logoKind,
    avoid: input.avoid,
    rules: COMPOSITOR_RULES,
    minScore: input.minScore ?? COMPOSITOR_RULES.minScore,
  });
  const page = readPage(await measureHtml(html, deps));
  if (!page) return { placed: false, reason: 'LOGO_NOT_DRAWN', detail: 'the browser did not answer' };
  const { result, image } = page;
  if (!result.ok) {
    const reason: PlacementRefusal = result.reason === 'NO_SAFE_PLACEMENT' ? 'NO_SAFE_PLACEMENT' : 'LOGO_NOT_DRAWN';
    return { placed: false, reason, detail: reason === 'NO_SAFE_PLACEMENT' ? `no place on the poster was quiet and clear enough (${result.considered ?? 0} looked at, best score ${result.bestScore ?? 0})` : (result.detail ?? 'the logo could not be drawn'), ...(result.bestScore !== undefined ? { bestScore: result.bestScore } : {}) };
  }
  const problem = verifyPlacement(result, posterInfo, input.avoid, input.logoKind);
  if (problem || !image) return { placed: false, reason: 'CHECK_FAILED', detail: problem ?? 'the finished picture was not returned' };
  const bytes = Buffer.from(image.slice('data:image/jpeg;base64,'.length), 'base64');
  await writeFile(input.outPath, bytes);
  const written = inspectLogoFile(input.outPath);
  if (written.width !== posterInfo.width || written.height !== posterInfo.height) return { placed: false, reason: 'CHECK_FAILED', detail: 'the saved picture is not the size of the poster' };
  return {
    placed: true,
    logoRect: result.logoRect as [number, number, number, number],
    plateRect: result.plateRect ?? null,
    plateColor: result.plateColor ?? null,
    treatment: result.treatment ?? 'none',
    haloColor: result.haloColor ?? null,
    score: result.score ?? 0,
    contrast: result.contrast ?? 0,
    logoSha256: logoInfo.sha256,
    outputSha256: sha256(bytes),
    width: written.width,
    height: written.height,
    considered: result.considered ?? 0,
    bestScores: result.bestScores ?? [],
  };
}
