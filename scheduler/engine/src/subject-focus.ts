/**
 * Where the subject of a generated picture is, so the crop can be centred on it instead of on the middle of the file. The picture model draws the
 * subject wherever the prompt's reserved text area leaves room, often off-centre, and a panel that shows only part of the picture would cut it.
 * The picture is read in headless Chrome (a canvas over a copy of the picture): the background is the most common colour at the picture's border,
 * and the subject is the area that differs from it. No model is called and nothing leaves the machine. When no clear subject is found (a busy
 * scene, or one filling the frame) the crop stays centred, as before.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { measureHtml, type ChromeDeps } from './chrome-render.ts';

/** A box inside the picture, each side as a share of the picture (0 to 1). */
export interface SubjectBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The picture's own size, to work out which of its sides a panel crops. */
  width: number;
  height: number;
}

const MIME: Readonly<Record<string, string>> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const ELEMENT_ID = 'subject-box';

const SCRIPT = `
(function () {
  var out = document.getElementById('${ELEMENT_ID}');
  function done(value) { out.textContent = JSON.stringify(value); }
  var img = document.getElementById('picture');
  function analyse() {
    try {
      var W = 96, H = Math.max(24, Math.min(192, Math.round(96 * img.naturalHeight / img.naturalWidth)));
      var canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, W, H);
      var data = ctx.getImageData(0, 0, W, H).data;
      function px(x, y) { var i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; }
      var counts = {}, best = null, bestN = 0, ring = Math.max(2, Math.round(Math.min(W, H) * 0.05));
      for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
        if (x >= ring && x < W - ring && y >= ring && y < H - ring) continue;
        var p = px(x, y), key = (p[0] >> 4) + ',' + (p[1] >> 4) + ',' + (p[2] >> 4);
        counts[key] = (counts[key] || 0) + 1;
        if (counts[key] > bestN) { bestN = counts[key]; best = key; }
      }
      var bg = best.split(',').map(function (v) { return Number(v) * 16 + 8; });
      var cols = new Array(W).fill(0), rows = new Array(H).fill(0), mask = 0;
      for (var yy = 0; yy < H; yy++) for (var xx = 0; xx < W; xx++) {
        var q = px(xx, yy), d = Math.sqrt(Math.pow(q[0] - bg[0], 2) + Math.pow(q[1] - bg[1], 2) + Math.pow(q[2] - bg[2], 2));
        if (d > 60) { cols[xx]++; rows[yy]++; mask++; }
      }
      var share = mask / (W * H);
      if (share < 0.01 || share > 0.8) return done({ found: false, share: share });
      var minCol = Math.max(1, Math.round(H * 0.02)), minRow = Math.max(1, Math.round(W * 0.02));
      var x0 = -1, x1 = -1, y0 = -1, y1 = -1;
      for (var a = 0; a < W; a++) if (cols[a] >= minCol) { if (x0 < 0) x0 = a; x1 = a; }
      for (var b = 0; b < H; b++) if (rows[b] >= minRow) { if (y0 < 0) y0 = b; y1 = b; }
      if (x0 < 0 || y0 < 0) return done({ found: false, share: share });
      done({ found: true, x0: x0 / W, x1: (x1 + 1) / W, y0: y0 / H, y1: (y1 + 1) / H, width: img.naturalWidth, height: img.naturalHeight, share: share });
    } catch (error) { done({ found: false, error: String(error && error.message ? error.message : error) }); }
  }
  if (img.complete && img.naturalWidth > 0) analyse(); else { img.onload = analyse; img.onerror = function () { done({ found: false, error: 'the picture did not load' }); }; }
})();
`;

/** Finds the subject of a picture file, or undefined when there is no clear one (or Chrome cannot read it). */
export async function findSubject(imagePath: string, deps: ChromeDeps = {}): Promise<SubjectBox | undefined> {
  const mime = MIME[extname(imagePath).toLowerCase()];
  if (!mime) return undefined;
  let bytes: Buffer;
  try {
    bytes = await readFile(imagePath);
  } catch {
    return undefined;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline';"></head><body><img id="picture" alt="" src="data:${mime};base64,${bytes.toString('base64')}"><script id="${ELEMENT_ID}" type="application/json"></script><script>${SCRIPT}</script></body></html>`;
  let dom: string;
  try {
    dom = await measureHtml(html, deps);
  } catch {
    return undefined;
  }
  const match = new RegExp(`<script id="${ELEMENT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(dom);
  if (!match) return undefined;
  try {
    const raw = JSON.parse(match[1] ?? '') as Partial<SubjectBox> & { found?: boolean };
    if (raw.found !== true) return undefined;
    const { x0, y0, x1, y1, width, height } = raw;
    if ([x0, y0, x1, y1, width, height].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return undefined;
    return { x0: x0 as number, y0: y0 as number, x1: x1 as number, y1: y1 as number, width: width as number, height: height as number };
  } catch {
    return undefined;
  }
}

/** Where to place a cropped picture, as CSS object-position percentages, so a panel of this shape keeps the subject inside what it shows. */
export interface Focus {
  x: number;
  y: number;
}

const PAD = 0.03;

/**
 * `object-position` for a picture shown with object-fit: cover in a panel of `panelAspect` (width over height): only the axis the panel crops moves.
 * The visible window is centred on the subject and kept inside the picture; if the subject is wider than the window it is still centred, which is
 * the best a crop can do, and the reviewer will say if it still cuts it.
 */
export function focusFor(box: SubjectBox, panelAspect: number): Focus {
  const sourceAspect = box.width / box.height;
  const place = (lo: number, hi: number, visible: number): number => {
    if (visible >= 1) return 50;
    const centre = (Math.max(0, lo - PAD) + Math.min(1, hi + PAD)) / 2;
    const offset = Math.min(1 - visible, Math.max(0, centre - visible / 2));
    return Math.round((offset / (1 - visible)) * 1000) / 10;
  };
  if (panelAspect < sourceAspect) return { x: place(box.x0, box.x1, panelAspect / sourceAspect), y: 50 };
  if (panelAspect > sourceAspect) return { x: 50, y: place(box.y0, box.y1, sourceAspect / panelAspect) };
  return { x: 50, y: 50 };
}

/** True when the subject, with its padding (which stops at the picture's own edge), fits in the part of the picture the panel shows. */
export function subjectFits(box: SubjectBox, panelAspect: number): boolean {
  const sourceAspect = box.width / box.height;
  const span = (lo: number, hi: number): number => Math.min(1, hi + PAD) - Math.max(0, lo - PAD);
  if (panelAspect < sourceAspect) return span(box.x0, box.x1) <= panelAspect / sourceAspect + 1e-9;
  if (panelAspect > sourceAspect) return span(box.y0, box.y1) <= sourceAspect / panelAspect + 1e-9;
  return true;
}

export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the subject lands on the poster for a panel and a focus, from how object-fit: cover scales and positions the picture; clipped to the panel. */
export function subjectOnCanvas(box: SubjectBox, panel: CanvasRect, focus: Focus): CanvasRect {
  const scale = Math.max(panel.w / box.width, panel.h / box.height);
  const sw = box.width * scale;
  const sh = box.height * scale;
  const ox = (sw - panel.w) * (focus.x / 100);
  const oy = (sh - panel.h) * (focus.y / 100);
  const x0 = Math.max(panel.x, panel.x - ox + box.x0 * sw);
  const y0 = Math.max(panel.y, panel.y - oy + box.y0 * sh);
  const x1 = Math.min(panel.x + panel.w, panel.x - ox + box.x1 * sw);
  const y1 = Math.min(panel.y + panel.h, panel.y - oy + box.y1 * sh);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
