/**
 * EXPERIMENT (hybrid): the image model makes the whole poster, headline included, and code adds only what the model cannot be trusted with: the brand's real mark and
 * the call to action. The model is told to leave a plain corner and a plain bottom strip and to put no logo, brand name, link or button anywhere. A poster is accepted
 * only if the text on it is exactly the approved headline (and supporting line), nothing else, and both areas really are plain; otherwise it is rejected, never patched.
 * The mark is the real asset from the site (the symbol alone when one was confirmed, see logo-assets.ts), drawn on a plate, never redrawn by the model.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { measureHtml, captureHtml, type ChromeDeps } from './chrome-render.ts';
import { contrastRatio } from './contrast.ts';
import { compareText, type TextCheck } from './ai-poster.ts';
import type { LogoTone } from './logo-tone.ts';

/** An area of the poster as shares of its width and height. */
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The clear areas the model is asked for, sized to hold the mark and the button with a margin. */
export const LOGO_ZONE: Zone = { x: 0, y: 0, w: 0.26, h: 0.17 };
export const CTA_ZONE: Zone = { x: 0, y: 0.86, w: 1, h: 0.14 };
const pct = (share: number): number => Math.round(share * 100);

export interface HybridPromptInput {
  headline: string;
  subline?: string;
  fact: string;
  colors: { background: string; ink: string; accent: string };
}

/** The prompt for the artwork and headline only: no brand mark, name, link or button, and two plain areas left open for the code to fill. */
export function buildHybridPrompt(input: HybridPromptInput): string {
  return [
    'Design one complete, professional square social media advertisement (1:1). You decide the whole composition: the artwork, the typography, the hierarchy and the layout.',
    `The only text on the poster must be exactly these words, spelled exactly as written, with no other words, numbers or symbols anywhere: HEADLINE: "${input.headline}"${input.subline ? ` SUPPORTING LINE: "${input.subline}"` : ''}`,
    'Apart from those exact words, draw no other text and no logo, brand name, web address, button, call to action or small print: the logo and the button are added afterwards.',
    `Leave two plain, empty areas: the top-left corner (about ${pct(LOGO_ZONE.w)}% of the width and ${pct(LOGO_ZONE.h)}% of the height) and a strip along the bottom (about ${pct(CTA_ZONE.h)}% of the height, full width). In both, use only the plain background colour or a very soft gradient: no text, icons, objects, faces, patterns or detail. Keep the artwork and the headline outside them.`,
    `The message of the poster is only this verified fact: "${input.fact}". Create an original visual idea that makes this fact clear to a stranger who is scrolling past. Show what the fact states and nothing more: no extra claims, offers, prices, statistics, awards, testimonials or promises.`,
    `Use the brand's colours: background ${input.colors.background}, ink ${input.colors.ink}, accent ${input.colors.accent}. Make the headline large and easy to read, with strong contrast against whatever is behind it.`,
    'Keep every important element fully inside the frame, with comfortable margins. Do not copy any existing advertisement, brand, slogan or character.',
  ].join(' ');
}

const ZONE_SCRIPT = `
(function () {
  var out = document.getElementById('zones');
  var img = document.getElementById('picture');
  var zones = JSON.parse(out.getAttribute('data-zones'));
  function run() {
    try {
      var W = 128, H = 128, canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, W, H);
      var data = ctx.getImageData(0, 0, W, H).data;
      var shares = zones.map(function (z) {
        var x0 = Math.floor(z.x * W), x1 = Math.max(x0 + 1, Math.ceil((z.x + z.w) * W)), y0 = Math.floor(z.y * H), y1 = Math.max(y0 + 1, Math.ceil((z.y + z.h) * H));
        var rs = [], gs = [], bs = [], px = [];
        for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) { var i = (y * W + x) * 4; px.push([data[i], data[i + 1], data[i + 2]]); rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); }
        var med = function (a) { a.sort(function (p, q) { return p - q; }); return a[a.length >> 1]; };
        var m = [med(rs), med(gs), med(bs)], near = 0;
        px.forEach(function (p) { if (Math.sqrt(Math.pow(p[0] - m[0], 2) + Math.pow(p[1] - m[1], 2) + Math.pow(p[2] - m[2], 2)) <= 40) near++; });
        return near / px.length;
      });
      out.textContent = JSON.stringify({ ok: true, shares: shares });
    } catch (error) { out.textContent = JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }); }
  }
  if (img.complete && img.naturalWidth > 0) run(); else { img.onload = run; img.onerror = function () { out.textContent = JSON.stringify({ ok: false, error: 'the picture did not load' }); }; }
})();
`;

const MIME: Readonly<Record<string, string>> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** For each zone, the share of its pixels close to the zone's own median colour: near 1 is plain, lower means objects, text or texture. Undefined when it cannot be read. */
export async function measurePlainness(imagePath: string, zones: readonly Zone[], deps: ChromeDeps = {}): Promise<number[] | undefined> {
  const mime = MIME[extname(imagePath).toLowerCase()];
  if (!mime) return undefined;
  let bytes: Buffer;
  try {
    bytes = await readFile(imagePath);
  } catch {
    return undefined;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; script-src 'unsafe-inline';"></head><body><img id="picture" alt="" src="data:${mime};base64,${bytes.toString('base64')}"><script id="zones" type="application/json" data-zones='${JSON.stringify(zones)}'></script><script>${ZONE_SCRIPT}</script></body></html>`;
  try {
    const dom = await measureHtml(html, deps);
    const match = /<script id="zones"[^>]*>([\s\S]*?)<\/script>/.exec(dom);
    const raw = JSON.parse(match?.[1] ?? '') as { ok?: boolean; shares?: number[] };
    return raw.ok === true && Array.isArray(raw.shares) && raw.shares.length === zones.length ? raw.shares : undefined;
  } catch {
    return undefined;
  }
}

/** A zone is plain enough to carry the mark or the button when at least this share of it is one colour. */
export const MIN_PLAIN_SHARE = 0.9;

export interface HybridChecks {
  text: TextCheck;
  /** Plainness of the logo zone and the call-to-action zone, or undefined when it could not be measured. */
  plain: { logo: number; cta: number } | undefined;
}

/**
 * Why a poster is rejected before anything is composited, or an empty list. Only the text rule is a hard rejection here: whether the reserved areas are clear
 * enough is judged by the vision reviewer on the finished poster, because a gradient or soft shading is fine for a mark and fails a one-colour pixel test.
 */
export function rejectionReasons(checks: HybridChecks, expected: { headline?: string; subline?: string }): string[] {
  const reasons: string[] = [];
  if (!checks.text.headlineExact) reasons.push('the headline on the poster is not the approved headline');
  if (expected.subline && checks.text.sublineExact !== true) reasons.push('the supporting line on the poster is not the approved one');
  if (checks.text.extraWords.length > 0) reasons.push(`the poster carries words that were not asked for: ${checks.text.extraWords.slice(0, 8).join(' ')}`);
  return reasons;
}

/** A diagnostic, never a rejection: the reserved corner or strip is not mostly one colour (or could not be measured). */
export function zoneWarnings(plain: { logo: number; cta: number } | undefined): string[] {
  if (!plain) return ['the areas kept for the mark and the button could not be measured'];
  const warnings: string[] = [];
  if (plain.logo < MIN_PLAIN_SHARE) warnings.push(`the corner kept for the mark is ${pct(plain.logo)}% one colour`);
  if (plain.cta < MIN_PLAIN_SHARE) warnings.push(`the strip kept for the button is ${pct(plain.cta)}% one colour`);
  return warnings;
}

export type RejectionCategory = 'headline' | 'extra_text' | 'reserved_area' | 'compositing' | 'relevance' | 'composition';

/** Sorts what went wrong into the pilot's categories so the first-attempt failure rate can be read off the report. */
export function categorize(input: { text?: TextCheck; textReasons: readonly string[]; defects: ReadonlyArray<{ code: string }>; warnings: readonly string[] }): RejectionCategory[] {
  const out = new Set<RejectionCategory>();
  if (input.textReasons.some((r) => /headline|supporting line/.test(r))) out.add('headline');
  if (input.textReasons.some((r) => /words that were not asked/.test(r))) out.add('extra_text');
  for (const { code } of input.defects) {
    if (code === 'cta_covers_subject' || code === 'text_overlap' || code === 'low_contrast') out.add('compositing');
    else if (code === 'picture_irrelevant' || code === 'picture_misleading' || code === 'message_unclear') out.add('relevance');
    else out.add('composition');
  }
  if (input.warnings.length > 0 && input.defects.length > 0) out.add('reserved_area');
  return [...out];
}

/** Compares the transcript with the approved text for the hybrid rule: the poster may carry the headline and supporting line and nothing else. */
export function hybridTextCheck(expected: { headline: string; subline?: string }, transcript: readonly string[]): TextCheck {
  return compareText({ headline: expected.headline, ...(expected.subline ? { subline: expected.subline } : {}), brandName: '' }, transcript);
}

export interface HybridCompose {
  /** The model's poster. */
  imagePath: string;
  /** The brand's real mark and whether it is the symbol alone. */
  mark: { path: string; kind: 'icon' | 'logo'; tone: LogoTone | null };
  cta?: { label: string; host: string };
  colors: { ink: string; accent: string };
}

const DARK_PLATE = '#14161C';
const LIGHT_PLATE = '#FFFFFF';
const CANVAS = 1080;
const MARGIN = 44;
const MAX_ONE_LINE_CTA_CHARS = 30;

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page: the model's poster across the whole canvas, the real mark on a plate in the top-left, the call to action at the bottom. Pure, so it can be tested without Chrome. */
export function composeHybridHtml(input: HybridCompose): string {
  const pale = (input.mark.tone?.pale ?? 0) > (input.mark.tone?.dark ?? 0);
  const plate = pale ? DARK_PLATE : LIGHT_PLATE;
  const markHeight = input.mark.kind === 'icon' ? 84 : 64;
  const ctaText = input.cta ? `${input.cta.label} ${input.cta.host}`.trim() : '';
  const stacked = input.cta !== undefined && input.cta.label.trim() !== '' && ctaText.length > MAX_ONE_LINE_CTA_CHARS;
  const ctaBackground = input.colors.ink;
  const ctaColor = contrastRatio('#FFFFFF', ctaBackground) >= contrastRatio('#111111', ctaBackground) ? '#FFFFFF' : '#111111';
  const cta = input.cta
    ? `<div data-slot="cta" style="position:absolute;left:${MARGIN}px;bottom:${MARGIN}px;background:${esc(ctaBackground)};color:${ctaColor};padding:14px 24px;border-radius:16px;font:800 ${stacked ? 24 : 27}px/1.15 Inter,Arial,Helvetica,sans-serif;">${stacked ? `${esc(input.cta.label)}<br>${esc(input.cta.host)}` : esc(ctaText)}</div>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline';"><style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:${CANVAS}px;height:${CANVAS}px;overflow:hidden}body{position:relative;background:#fff}</style></head><body>` +
    `<img data-slot="poster" alt="" src="${esc(pathToFileURL(input.imagePath).href)}" style="position:absolute;left:0;top:0;width:${CANVAS}px;height:${CANVAS}px;object-fit:cover;">` +
    `<div data-slot="mark" data-kind="${input.mark.kind}" style="position:absolute;left:${MARGIN}px;top:${MARGIN}px;background:${plate};padding:14px 18px;border-radius:16px;"><img alt="" src="${esc(pathToFileURL(input.mark.path).href)}" style="display:block;height:${markHeight}px;width:auto;max-width:240px;"></div>` +
    `${cta}</body></html>`;
}

/** Draws the page and writes it as a 1080 x 1080 PNG. */
export async function captureHybrid(input: HybridCompose, outPng: string, deps: ChromeDeps = {}): Promise<void> {
  await captureHtml(composeHybridHtml(input), outPng, deps);
}
