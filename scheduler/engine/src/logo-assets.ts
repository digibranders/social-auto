/**
 * The brand's own mark, taken from its site and never redrawn. A poster may show the symbol alone (smaller, easier to place) instead of the whole logo, but only
 * when the site has a standalone icon and a model has confirmed it is the same mark that appears in the logo: a generic favicon (a site builder's default, a
 * lone letter) is not the brand. The icon is saved beside the logo with its source; the logo stays the fallback.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { downloadImage } from './analyze.ts';
import { captureHtml } from './chrome-render.ts';
import type { Brand, LogoIcon } from './content.ts';
import { chatJson } from './llm.ts';
import type { FetchedBytes } from './safe-fetch.ts';

const RASTER: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** A picture a model can look at: a raster file as it is, an SVG drawn onto a white square in Chrome. Undefined for anything else (an .ico, say). */
export async function rasterForModel(path: string, workDir: string, name: string): Promise<{ path: string; mime: string } | undefined> {
  const ext = extname(path).toLowerCase();
  if (RASTER[ext]) return { path, mime: RASTER[ext] as string };
  if (ext !== '.svg') return undefined;
  await mkdir(workDir, { recursive: true });
  const out = join(workDir, `${name}.png`);
  const svg = (await readFile(path, 'utf8')).replace(/<\?xml[^>]*>/, '');
  await captureHtml(`<!doctype html><html><body style="margin:0;width:1080px;height:1080px;background:#999;display:flex;align-items:center;justify-content:center"><div style="width:800px">${svg}</div></body></html>`, out);
  return { path: out, mime: 'image/png' };
}

const MATCH_SYSTEM = `You compare two pictures from a company's website. Picture 1 is the company's logo. Picture 2 is the website's small icon (its favicon or app icon). Answer whether picture 2 is the same brand symbol that appears in picture 1, as a recognisable part of that logo or an identical version of it. Answer false if picture 2 is a generic or unrelated icon (a default site-builder globe, a single plain letter that is not in the logo, a placeholder), if it is blank or unreadable, or if you cannot tell. Return JSON only: {"matches":true|false,"reason":"one short line"}`;

export interface IconMatch {
  matches: boolean;
  reason: string;
}

/** One vision request that checks the icon against the logo; any doubt is a no. */
export async function iconMatchesLogo(ai: AiConfig, logo: { path: string; mime: string }, icon: { path: string; mime: string }, fetchFn?: typeof fetch): Promise<IconMatch> {
  const toUrl = async (picture: { path: string; mime: string }): Promise<string> => `data:${picture.mime};base64,${(await readFile(picture.path)).toString('base64')}`;
  return chatJson({
    ai,
    ...(fetchFn ? { fetchFn } : {}),
    system: MATCH_SYSTEM,
    user: 'Is picture 2 the same brand symbol as in picture 1?',
    images: [await toUrl(logo), await toUrl(icon)],
    parse: (value) => {
      const raw = value as { matches?: unknown; reason?: unknown };
      if (typeof raw.matches !== 'boolean') throw new Error('"matches" must be true or false');
      return { matches: raw.matches, reason: typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 200) : '' };
    },
  });
}

export interface CaptureIconInput {
  brandDir: string;
  brand: Pick<Brand, 'logo'>;
  /** The icon addresses the site declares, best first (the crawl finds them). */
  iconCandidates: readonly string[];
  fetchBytes: (url: string) => Promise<FetchedBytes>;
  ai: AiConfig;
  now?: () => Date;
  fetchFn?: typeof fetch;
}

const EXT: Readonly<Record<string, string>> = { 'image/svg+xml': '.svg', 'image/png': '.png', 'image/webp': '.webp', 'image/jpeg': '.jpg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico' };

/**
 * Downloads the site's icon, saves it as assets/icon.<ext> and checks it against the logo. Returns the record to store on the brand, or undefined when the site
 * has no icon that downloads. A record with `matchesLogo: false` is still returned so the check is not repeated blindly and a person can read why.
 */
export async function captureBrandIcon(input: CaptureIconInput): Promise<LogoIcon | undefined> {
  const found = await downloadImage([...input.iconCandidates], input.fetchBytes);
  if (!found) return undefined;
  const ext = EXT[found.type.split(';')[0]?.trim() ?? ''] ?? (extname(new URL(found.url).pathname).toLowerCase() || '.png');
  const assets = join(input.brandDir, 'assets');
  await mkdir(assets, { recursive: true });
  const file = `icon${ext}`;
  await writeFile(join(assets, file), found.bytes);
  const work = join(input.brandDir, 'assets', '.check');
  const logo = await rasterForModel(join(input.brandDir, input.brand.logo), work, 'logo');
  const icon = await rasterForModel(join(assets, file), work, 'icon');
  let match: IconMatch = { matches: false, reason: 'the icon or the logo could not be shown to a model (for example an .ico file), so it was not confirmed' };
  if (logo && icon) {
    try {
      match = await iconMatchesLogo(input.ai, logo, icon, input.fetchFn);
    } catch (error) {
      match = { matches: false, reason: `the check could not run: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` };
    }
  }
  return {
    savedAs: `assets/${file}`,
    imageUrl: found.url,
    contentType: found.type,
    contentHash: `sha256:${createHash('sha256').update(found.bytes).digest('hex')}`,
    fetchedAt: (input.now?.() ?? new Date()).toISOString(),
    matchesLogo: match.matches,
    ...(match.reason ? { reason: match.reason } : {}),
  };
}

export type LogoMark = { kind: 'icon' | 'logo'; path: string };

/** The mark a poster shows: the symbol alone when the site has one that was confirmed to match its logo, the whole logo otherwise. */
export function chooseLogoMark(brand: Pick<Brand, 'logo' | 'logoIcon'>): LogoMark {
  return brand.logoIcon?.matchesLogo === true ? { kind: 'icon', path: brand.logoIcon.savedAs } : { kind: 'logo', path: brand.logo };
}
