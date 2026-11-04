/**
 * Composes a poster's HTML from an art brief: one composer per layout family, built from shared primitives (text slots,
 * picture slots, panels, scrims, the brand strip). All geometry comes from the layout registry's slot rectangles; colours
 * come from the brand's own tokens; text is the approved copy, escaped, with the planner's |accent| spans kept as they are.
 * A page is composed in one of two modes: "measure" carries the solver script that finds the largest fitting font sizes in a
 * real browser, and "frozen" carries those solved sizes and no script, so what is captured is exactly what was measured.
 * The page may load only local files; the content security policy blocks every network request.
 */
import type { ArtBrief } from './art-brief.ts';
import { TARGET_RATIO, backingAlpha, composite, contrastRatio } from './contrast.ts';
import { escapeHtml, parseHeadline, type BrandColors } from './content.ts';
import { CANVAS_SIZE, darken, lighten, luminance, washColor } from './layout.ts';
import { plateFor, type LogoTone } from './logo-tone.ts';
import { layoutRegistry, familyById, type LayoutFamily, type Rect, type SlotDefinition, type ZoneLayout } from './layout-registry.ts';
import { SOLVER_SCRIPT } from './measure-script.ts';
import { ROLE_RANGE, headlineRange, textStyleFor, type ResolvedFont, type TextRole } from './typography.ts';

export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeError';
  }
}

export interface PosterCopy {
  /** With |accent| markers. */
  headline: string;
  subline: string;
  listItems?: readonly string[];
  /** A verified figure to show large. */
  figure?: string;
  /** A verified, attributable quotation to show large. */
  quote?: string;
}

export interface PosterBrand {
  name: string;
  colors: BrandColors;
  identityLine?: string;
  cta?: { label: string; host: string };
  /** Inline <svg> or an <img> of a local file; absent when the brand has no logo. */
  logoHtml?: string;
  logoTone?: LogoTone | null;
}

export type ComposeMode = { kind: 'measure' } | { kind: 'frozen'; solved: Readonly<Record<string, number>> };

export interface ContrastCheck {
  slot: string;
  ratio: number;
  target: number;
  ok: boolean;
}

export interface ComposeInput {
  brief: ArtBrief;
  copy: PosterCopy;
  brand: PosterBrand;
  /** A file: URL of the generated picture; without one a measuring page shows a placeholder and a frozen page refuses. */
  pictureUrl?: string;
  font: ResolvedFont;
  mode: ComposeMode;
  registry?: readonly LayoutFamily[];
}

export interface ComposeResult {
  html: string;
  contrast: ContrastCheck[];
}

type SurfaceKind = 'dark' | 'light' | 'picture' | 'scrim';
interface Surface {
  rect: Rect;
  kind: SurfaceKind;
}

const DARK_PLATE = '#14161C';
const FALLBACK_DARK = '#0F1722';

const px = (value: number): string => `${Math.round(value * 100) / 100}px`;
const rectCss = (r: Rect): string => `left:${px(r.x)};top:${px(r.y)};width:${px(r.w)};height:${px(r.h)};`;
const inside = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

function unionOf(rects: readonly Rect[]): Rect {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function headlineHtml(headline: string): string {
  return parseHeadline(headline)
    .map((segment) => (segment.accent ? `<span class="accent">${escapeHtml(segment.text)}</span>` : escapeHtml(segment.text)))
    .join('');
}

interface Palette {
  dark: string;
  light: string;
  textOnDark: string;
  textOnLight: string;
  accentOnDark: string;
  accentOnLight: string;
  accent: string;
  ink: string;
}

function paletteOf(colors: BrandColors): Palette {
  const dark = luminance(colors.ink) < 0.25 ? colors.ink : FALLBACK_DARK;
  const light = washColor(colors.background);
  const textOnLight = contrastRatio(colors.ink, light) >= TARGET_RATIO ? colors.ink : '#111111';
  const accentOnDark = contrastRatio(luminance(colors.accent) > 0.35 ? colors.accent : lighten(colors.accent, 0.4), dark) >= 3 ? (luminance(colors.accent) > 0.35 ? colors.accent : lighten(colors.accent, 0.4)) : '#FFFFFF';
  let accentOnLight = darken(colors.accent, 0.22);
  for (let i = 0; i < 4 && contrastRatio(accentOnLight, light) < 3; i++) accentOnLight = darken(accentOnLight, 0.25);
  if (contrastRatio(accentOnLight, light) < 3) accentOnLight = textOnLight;
  return { dark, light, textOnDark: '#FFFFFF', textOnLight, accentOnDark, accentOnLight, accent: colors.accent, ink: colors.ink };
}

class Canvas {
  readonly parts: string[] = [];
  readonly css: string[] = [];
  readonly surfaces: Surface[] = [];
  readonly contrast: ContrastCheck[] = [];

  readonly input: ComposeInput;
  readonly family: LayoutFamily;
  readonly zoneName: string;
  readonly zone: ZoneLayout;
  readonly palette: Palette;

  constructor(input: ComposeInput, family: LayoutFamily, zoneName: string, zone: ZoneLayout, palette: Palette) {
    this.input = input;
    this.family = family;
    this.zoneName = zoneName;
    this.zone = zone;
    this.palette = palette;
  }

  slot(id: string): SlotDefinition | undefined {
    return this.zone.textSlots.find((s) => s.id === id);
  }

  surfaceAt(rect: Rect): SurfaceKind {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    for (let i = this.surfaces.length - 1; i >= 0; i--) {
      const surface = this.surfaces[i] as Surface;
      if (inside(surface.rect, cx, cy)) return surface.kind;
    }
    return 'dark';
  }

  surface(rect: Rect, kind: SurfaceKind): void {
    this.surfaces.push({ rect, kind });
  }

  check(slot: string, text: string, background: string): void {
    const ratio = Math.round(contrastRatio(text, background) * 100) / 100;
    this.contrast.push({ slot, ratio, target: TARGET_RATIO, ok: ratio >= TARGET_RATIO });
  }

  /** Text colours for a surface, and the contrast of the text against its worst-case background. */
  colorsOn(kind: SurfaceKind, slot: string, textRole: TextRole): { text: string; accent: string } {
    const p = this.palette;
    if (kind === 'light') {
      this.check(slot, p.textOnLight, p.light);
      return { text: p.textOnLight, accent: p.accentOnLight };
    }
    // Dark, scrim and picture-with-backing surfaces all carry white text on the brand's dark token.
    const worst = kind === 'picture' && textRole !== 'headline' ? composite(p.dark, backingAlpha(p.textOnDark, p.dark) ?? 1, '#FFFFFF') : p.dark;
    this.check(slot, p.textOnDark, worst);
    return { text: p.textOnDark, accent: p.accentOnDark };
  }

  text(opts: {
    slot: string;
    role: TextRole;
    html: string;
    plain: string;
    rect: Rect;
    surface: SurfaceKind;
    anchor?: 'start' | 'end';
    weight?: number;
    fit: { max: number; min: number; maxLines: number };
    hug?: boolean;
    justify?: 'flex-start' | 'flex-end';
    backing?: boolean;
    extraStyle?: string;
  }): void {
    const { text, accent } = this.colorsOn(opts.surface, opts.slot, opts.role);
    const display = opts.role === 'headline' || opts.role === 'figure';
    const style = textStyleFor(opts.plain, display);
    const align = this.input.brief.alignment === 'center' && opts.role !== 'identity' && opts.role !== 'cta' && opts.role !== 'brand' ? 'center' : 'start';
    const solved = this.input.mode.kind === 'frozen' ? this.input.mode.solved[opts.slot] : undefined;
    const size = solved ?? opts.fit.max;
    const backing = opts.backing ? `background:rgba(${hexToRgb(this.palette.dark)},${backingAlpha(this.palette.textOnDark, this.palette.dark) ?? 1});padding:8px 16px;border-radius:12px;` : '';
    const wrapper =
      opts.hug === true
        ? `display:flex;align-items:center;justify-content:${opts.justify ?? 'flex-start'};`
        : `display:flex;flex-direction:column;justify-content:${opts.anchor === 'end' ? 'flex-end' : 'flex-start'};`;
    this.parts.push(
      `<div class="slot" style="${rectCss(opts.rect)}${wrapper}">` +
        `<div class="fit" data-fit="1" data-slot="${opts.slot}" data-role="${opts.role}" data-layer="${opts.role === 'identity' || opts.role === 'cta' || opts.role === 'brand' ? 'brand' : 'text'}" ` +
        `data-fit-max="${opts.fit.max}" data-fit-min="${opts.fit.min}" data-max-lines="${opts.fit.maxLines}" data-slot-w="${Math.round(opts.rect.w)}" data-slot-h="${Math.round(opts.rect.h)}" ` +
        `dir="${style.dir}" style="color:${text};--accent:${accent};font-size:${size}px;line-height:${style.lineHeight};letter-spacing:${style.letterSpacingEm}em;text-align:${align};font-weight:${opts.weight ?? 600};` +
        `${opts.hug === true ? 'width:fit-content;max-width:100%;' : 'width:100%;'}${backing}${opts.extraStyle ?? ''}">${opts.html}</div></div>`,
    );
  }

  picture(role: 'hero' | 'supporting' | 'texture', extra: { opacity?: number; radius?: number; style?: string } = {}): Rect | undefined {
    if (this.input.brief.picture.role !== role) return undefined;
    const slot = this.zone.imageSlots.find((s) => s.id === role);
    if (!slot) throw new ComposeError(`${this.family.id}/${this.zoneName} has no "${role}" picture slot`);
    const url = this.input.pictureUrl;
    if (url !== undefined) {
      if (!isLocalFileUrl(url)) throw new ComposeError('the picture must be a local file: URL');
      this.parts.push(`<img data-layer="picture" data-slot="picture" alt="" src="${escapeHtml(url)}" style="${rectCss(slot.rect)}object-fit:cover;${extra.opacity !== undefined ? `opacity:${extra.opacity};` : ''}${extra.radius ? `border-radius:${extra.radius}px;` : ''}${extra.style ?? ''}">`);
    } else if (this.input.mode.kind === 'frozen') {
      throw new ComposeError('a frozen poster needs its picture');
    } else {
      this.parts.push(`<div data-layer="picture" data-placeholder="1" style="${rectCss(slot.rect)}background:linear-gradient(135deg,#9AA3AD,#5C6670);${extra.opacity !== undefined ? `opacity:${extra.opacity};` : ''}${extra.radius ? `border-radius:${extra.radius}px;` : ''}${extra.style ?? ''}"></div>`);
    }
    return slot.rect;
  }

  decor(rect: Rect, style: string): void {
    this.parts.push(`<div data-layer="decor" style="${rectCss(rect)}${style}"></div>`);
  }
}

function hexToRgb(hex: string): string {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(',');
}

function isLocalFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

function headlineAndSubline(c: Canvas, surface: SurfaceKind, anchor: 'start' | 'end' = 'end'): void {
  const { copy, brief } = c.input;
  const headline = c.slot('headline');
  if (!headline) throw new ComposeError(`${c.family.id}/${c.zoneName} has no headline slot`);
  c.text({ slot: 'headline', role: 'headline', html: headlineHtml(copy.headline), plain: parseHeadline(copy.headline).map((s) => s.text).join(''), rect: headline.rect, surface, anchor, weight: 900, fit: headlineRange(c.family, brief.headlineScale) });
  const subline = c.slot('subline');
  if (subline && copy.subline.trim()) c.text({ slot: 'subline', role: 'subline', html: escapeHtml(copy.subline), plain: copy.subline, rect: subline.rect, surface, weight: 500, fit: ROLE_RANGE.subline });
}

/** The logo (or the brand name), identity line and CTA, each in its own slot over whatever surface lies beneath it. */
function brandStrip(c: Canvas): void {
  const { brief, brand } = c.input;
  const p = c.palette;
  const logoSlot = c.family.logoSlots.find((s) => s.id === brief.logoSlot);
  const identitySlot = c.family.identitySlots.find((s) => s.id === brief.identitySlot);
  const ctaSlot = c.family.ctaSlots.find((s) => s.id === brief.ctaSlot);
  if (!logoSlot || !identitySlot || !ctaSlot) throw new ComposeError(`${c.family.id} has no slot "${brief.logoSlot}", "${brief.identitySlot}" or "${brief.ctaSlot}"`);

  const logoSurface = c.surfaceAt(logoSlot.rect);
  if (brand.logoHtml) {
    const plate = plateFor(brand.logoTone ?? null, p.light, DARK_PLATE);
    const blends = (logoSurface === 'dark' || logoSurface === 'scrim') ? plate === DARK_PLATE : logoSurface === 'light' && plate !== DARK_PLATE;
    const plateStyle = blends ? '' : `background:${plate};padding:8px 16px;border-radius:16px;${plate === DARK_PLATE ? 'box-shadow:0 0 0 2px rgba(255,255,255,0.16);' : ''}`;
    c.parts.push(`<div class="slot" style="${rectCss(logoSlot.rect)}display:flex;align-items:center;justify-content:flex-start;"><div class="plate" data-layer="brand" data-slot="logo" style="${plateStyle}">${brand.logoHtml}</div></div>`);
  } else {
    const colors = logoSurface === 'light' ? p.textOnLight : p.textOnDark;
    c.text({ slot: 'logo', role: 'brand', html: escapeHtml(brand.name), plain: brand.name, rect: logoSlot.rect, surface: logoSurface, weight: 800, fit: ROLE_RANGE.brand, hug: true, backing: logoSurface === 'picture', extraStyle: `color:${colors};` });
  }

  if (brand.identityLine?.trim()) {
    const surface = c.surfaceAt(identitySlot.rect);
    c.text({ slot: 'identity', role: 'identity', html: escapeHtml(brand.identityLine), plain: brand.identityLine, rect: identitySlot.rect, surface, weight: 600, fit: ROLE_RANGE.identity, hug: true, backing: surface === 'picture' });
  }
  if (brand.cta) {
    const surface = c.surfaceAt(ctaSlot.rect);
    const right = ctaSlot.rect.x + ctaSlot.rect.w / 2 > CANVAS_SIZE / 2;
    c.text({
      slot: 'cta', role: 'cta', html: `${escapeHtml(brand.cta.label)} <span class="host">${escapeHtml(brand.cta.host)}</span>`, plain: `${brand.cta.label} ${brand.cta.host}`,
      rect: ctaSlot.rect, surface, weight: 800, fit: ROLE_RANGE.cta, hug: true, justify: right ? 'flex-end' : 'flex-start', backing: surface === 'picture',
    });
  }
}

function listHtml(items: readonly string[]): string {
  return `<ol class="list">${items.map((item) => `<li><span class="num"></span><span class="item">${escapeHtml(item)}</span></li>`).join('')}</ol>`;
}

type Composer = (c: Canvas) => void;

const composers: Record<string, Composer> = {
  'typography-hero': (c) => {
    const { dark, accentOnDark } = c.palette;
    c.css.push(`body{background:${dark};}`);
    c.surface({ x: 0, y: 0, w: CANVAS_SIZE, h: CANVAS_SIZE }, 'dark');
    const texture = c.picture('texture', { opacity: 0.28 });
    if (texture) c.check('texture', '#FFFFFF', composite('#FFFFFF', 0.28, dark));
    const subline = c.slot('subline');
    if (subline) c.decor({ x: subline.rect.x, y: subline.rect.y - 30, w: 120, h: 10 }, `background:${accentOnDark};`);
    headlineAndSubline(c, 'dark');
  },

  'split-composition': (c) => {
    const { light } = c.palette;
    c.css.push(`body{background:${light};}`);
    c.surface({ x: 0, y: 0, w: CANVAS_SIZE, h: CANVAS_SIZE }, 'light');
    const rect = c.picture('hero');
    if (rect) {
      c.surface(rect, 'picture');
      const vertical = rect.h >= CANVAS_SIZE;
      const edge = vertical ? { x: rect.x === 0 ? rect.w - 5 : rect.x - 5, y: 0, w: 10, h: CANVAS_SIZE } : { x: 0, y: rect.y === 0 ? rect.h - 5 : rect.y - 5, w: CANVAS_SIZE, h: 10 };
      c.decor(edge, `background:${c.palette.accent};`);
    }
    headlineAndSubline(c, 'light');
  },

  'full-bleed-editorial': (c) => {
    const { dark, textOnDark } = c.palette;
    c.css.push(`body{background:${dark};}`);
    const rect = c.picture('hero');
    if (rect) c.surface(rect, 'picture');
    const headline = c.slot('headline');
    const subline = c.slot('subline');
    if (!headline) throw new ComposeError('no headline slot');
    const region = unionOf([headline.rect, ...(subline ? [subline.rect] : [])]);
    const alpha = backingAlpha(textOnDark, dark) ?? 1;
    const color = `rgba(${hexToRgb(dark)}`;
    const fade = 220;
    const a = (value: number): string => `${color},${value})`;
    const stops = (end: number): string => `${a(alpha)} 0px, ${a(alpha)} ${px(end)}, ${a(0)} ${px(end + fade)}`;
    const gradient =
      c.zoneName === 'top' ? `linear-gradient(180deg, ${stops(region.y + region.h + 40)})`
      : c.zoneName === 'bottom' ? `linear-gradient(0deg, ${stops(CANVAS_SIZE - region.y + 40)})`
      : c.zoneName === 'right' ? `linear-gradient(270deg, ${stops(CANVAS_SIZE - region.x + 40)})`
      : c.zoneName === 'left' ? `linear-gradient(90deg, ${stops(region.x + region.w + 40)})`
      : `linear-gradient(0deg, ${a(alpha)}, ${a(alpha)})`;
    c.parts.push(`<div data-layer="scrim" style="left:0;top:0;width:${CANVAS_SIZE}px;height:${CANVAS_SIZE}px;background:${gradient};"></div>`);
    c.surface({ x: Math.max(0, region.x - 40), y: Math.max(0, region.y - 40), w: Math.min(CANVAS_SIZE, region.w + 80), h: Math.min(CANVAS_SIZE, region.h + 80) }, 'scrim');
    headlineAndSubline(c, 'scrim');
    // Text sits on the scrim at the worst case: a white picture under a scrim of the computed opacity.
    c.check('scrim', textOnDark, composite(dark, alpha, '#FFFFFF'));
  },

  'feature-spotlight': (c) => {
    const { light, accent } = c.palette;
    const tile = luminance(c.input.brand.colors.tile) >= 0.6 ? c.input.brand.colors.tile : light;
    c.css.push(`body{background:${tile};}`);
    c.surface({ x: 0, y: 0, w: CANVAS_SIZE, h: CANVAS_SIZE }, 'light');
    const slot = c.zone.imageSlots.find((s) => s.id === 'hero');
    if (slot && c.input.brief.picture.role === 'hero') c.decor({ x: slot.rect.x + 18, y: slot.rect.y + 18, w: slot.rect.w, h: slot.rect.h }, `background:${accent};opacity:0.35;border-radius:32px;`);
    const rect = c.picture('hero', { radius: 32, style: `box-shadow:0 18px 40px rgba(0,0,0,0.18);` });
    if (rect) c.surface(rect, 'picture');
    headlineAndSubline(c, 'light', 'start');
  },

  'structured-information': (c) => {
    const { light, textOnLight, accentOnLight } = c.palette;
    c.css.push(`body{background:${light};}`);
    c.surface({ x: 0, y: 0, w: CANVAS_SIZE, h: CANVAS_SIZE }, 'light');
    const rect = c.picture('supporting', { radius: 24 });
    if (rect) c.surface(rect, 'picture');
    c.css.push(`.list{list-style:none;counter-reset:n;margin:0;padding:0;} .list li{counter-increment:n;display:flex;align-items:baseline;gap:20px;padding:14px 0;border-bottom:2px solid ${textOnLight}26;} .list li:last-child{border-bottom:none;} .list .num::before{content:counter(n);color:${accentOnLight};font-weight:900;} .list .num{min-width:1.4em;}`);
    headlineAndSubline(c, 'light', 'start');
    const list = c.slot('list');
    const items = c.input.copy.listItems ?? [];
    if (list && items.length > 0) c.text({ slot: 'list', role: 'list', html: listHtml(items), plain: items.join(' '), rect: list.rect, surface: 'light', anchor: 'start', weight: 600, fit: ROLE_RANGE.list });
  },

  'evidence-spotlight': (c) => {
    const { dark, accentOnDark } = c.palette;
    c.css.push(`body{background:${dark};}`);
    c.surface({ x: 0, y: 0, w: CANVAS_SIZE, h: CANVAS_SIZE }, 'dark');
    const texture = c.picture('texture', { opacity: 0.25 });
    if (texture) c.check('texture', '#FFFFFF', composite('#FFFFFF', 0.25, dark));
    const supporting = c.picture('supporting', { radius: 24 });
    if (supporting) c.surface(supporting, 'picture');
    const figure = c.slot('figure');
    const { figure: figureText, quote } = c.input.copy;
    if (figure && figureText) {
      c.text({ slot: 'figure', role: 'figure', html: escapeHtml(figureText), plain: figureText, rect: figure.rect, surface: 'dark', anchor: 'end', weight: 900, fit: ROLE_RANGE.figure, extraStyle: `color:${accentOnDark};` });
    } else if (figure && quote) {
      c.text({ slot: 'figure', role: 'quote', html: `&ldquo;${escapeHtml(quote)}&rdquo;`, plain: quote, rect: figure.rect, surface: 'dark', anchor: 'end', weight: 700, fit: ROLE_RANGE.quote });
    } else if (c.input.brief.hierarchy === 'figure-first') {
      throw new ComposeError('a figure-first poster needs a verified figure or quotation');
    }
    headlineAndSubline(c, 'dark', 'start');
  },
};

const FRAME_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${CANVAS_SIZE}px; height: ${CANVAS_SIZE}px; overflow: hidden; }
  body { position: relative; }
  .slot, [data-layer="picture"], [data-layer="scrim"], [data-layer="decor"] { position: absolute; }
  .fit { overflow-wrap: break-word; hyphens: manual; }
  .fit .accent { color: var(--accent); }
  .fit .host { font-weight: 600; opacity: 0.88; }
  .plate svg, .plate img { height: 54px; width: auto; max-width: 420px; object-fit: contain; display: block; }
  .plate { max-width: 100%; }
`;

/** Composes a poster page. Throws ComposeError for a brief the registry cannot draw or content the family needs and the post lacks. */
export function composePoster(input: ComposeInput): ComposeResult {
  const registry = input.registry ?? layoutRegistry;
  const { brief } = input;
  const family = familyById(registry, brief.layout);
  if (!family) throw new ComposeError(`unknown layout "${brief.layout}"`);
  const zone = family.zones[brief.textZone];
  if (!zone) throw new ComposeError(`${family.id} has no "${brief.textZone}" zone`);
  const composer = composers[family.id];
  if (!composer) throw new ComposeError(`no composer for layout "${family.id}"`);
  if (brief.picture.role !== 'none' && !zone.imageSlots.some((s) => s.id === brief.picture.role)) {
    throw new ComposeError(`${family.id}/${brief.textZone} has no "${brief.picture.role}" picture slot`);
  }

  const canvas = new Canvas(input, family, brief.textZone, zone, paletteOf(input.brand.colors));
  composer(canvas);
  brandStrip(canvas);

  const measuring = input.mode.kind === 'measure';
  const csp = `default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; font-src file: data:;${measuring ? " script-src 'unsafe-inline';" : ''}`;
  const html = `<!doctype html>
<html data-font-source="${input.font.source}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${input.font.css}
${FRAME_CSS}
  body { font-family: ${input.font.stack}; }
${canvas.css.join('\n')}
</style></head>
<body class="family-${family.id}" data-canvas="${CANVAS_SIZE}" data-margin="32" data-clearance="8">
${canvas.parts.join('\n')}
${measuring ? `<script>${SOLVER_SCRIPT}</script>` : ''}
</body></html>`;
  return { html, contrast: canvas.contrast };
}
