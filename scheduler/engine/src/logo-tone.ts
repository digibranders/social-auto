/**
 * Reads how light or dark a client's logo really is, so a poster can put it on a plate it shows up on. A pale logo made
 * for dark backgrounds (Discord's) vanishes on a light plate, and nothing in the site says so: the picture has to be looked at.
 * The browser the engine already needs does the looking: it draws the logo and averages its visible pixels.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chromeDumpArgs, chromePath } from './platform.ts';

const run = promisify(execFile);

const MIME: Readonly<Record<string, string>> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon' };

/** A pixel at least this light (relative luminance) is lost on a light plate; at most the second value, on a dark plate. */
const PALE_FROM = 0.55;
const DARK_UP_TO = 0.15;

/** How much of a logo is pale and how much is dark, as shares (0 to 1) of its visible pixels; the rest is in between. */
export interface LogoTone {
  pale: number;
  dark: number;
}

/** The page that draws the logo on a canvas and writes the pale and dark shares of its visible pixels on the body. */
export function logoToneHtml(dataUri: string): string {
  return `<!doctype html><html><body><script>
const img = new Image();
img.onload = () => {
  const box = { w: 256, h: 128 };
  const ratio = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 4;
  const w = ratio >= box.w / box.h ? box.w : Math.round(box.h * ratio);
  const h = ratio >= box.w / box.h ? Math.round(box.w / ratio) : box.h;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const context = canvas.getContext('2d');
  context.drawImage(img, 0, 0, w, h);
  const pixels = context.getImageData(0, 0, w, h).data;
  const linear = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  let pale = 0, dark = 0, weight = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] / 255;
    if (a < 0.1) continue;
    const lum = 0.2126 * linear(pixels[i]) + 0.7152 * linear(pixels[i + 1]) + 0.0722 * linear(pixels[i + 2]);
    if (lum >= ${PALE_FROM}) pale += a;
    else if (lum <= ${DARK_UP_TO}) dark += a;
    weight += a;
  }
  if (weight > 0) {
    document.body.setAttribute('data-pale', (pale / weight).toFixed(4));
    document.body.setAttribute('data-dark', (dark / weight).toFixed(4));
  }
};
img.src = ${JSON.stringify(dataUri)};
</script></body></html>`;
}

function share(dom: string, name: string): number | null {
  const value = dom.match(new RegExp(`data-${name}="([^"]*)"`))?.[1];
  if (value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

/** What the page wrote, or null when it wrote nothing (the logo did not load, or had nothing visible). */
export function parseTone(dom: string): LogoTone | null {
  const pale = share(dom, 'pale');
  const dark = share(dom, 'dark');
  return pale === null || dark === null ? null : { pale, dark };
}

/**
 * The dark plate only for a logo that is mostly pale: it must have at least twice as much pale as dark in it, so a logo that
 * mixes a dark name with a coloured mark keeps the light plate, where its dark part shows. Unknown means the light plate.
 */
export function plateFor(tone: LogoTone | null, light: string, dark: string): string {
  return tone !== null && tone.pale >= 0.2 && tone.pale >= 2 * tone.dark ? dark : light;
}

export interface ToneDeps {
  /** Opens the page in the browser and returns it as it looks afterwards. */
  dump?: (html: string) => Promise<string>;
}

async function dumpWithChrome(html: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-tone-'));
  try {
    const page = join(dir, 'tone.html');
    await writeFile(page, html);
    const { stdout } = await run(chromePath(process.env, process.platform), chromeDumpArgs(join(dir, 'profile'), pathToFileURL(page).href, process.env), { maxBuffer: 4_000_000 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** How pale and how dark the logo file is; null when it cannot be told, so the poster uses its usual plate instead of failing. */
export async function measureLogoTone(logoPath: string, deps: ToneDeps = {}): Promise<LogoTone | null> {
  const mime = MIME[extname(logoPath).toLowerCase()];
  if (!mime) return null;
  try {
    const bytes = await readFile(logoPath);
    const dom = await (deps.dump ?? dumpWithChrome)(logoToneHtml(`data:${mime};base64,${bytes.toString('base64')}`));
    return parseTone(dom);
  } catch {
    return null;
  }
}
