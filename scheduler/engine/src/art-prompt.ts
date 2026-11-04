/**
 * The image prompt for a post that has an art brief, built by code from three things that are not the model's to change:
 * the accepted concept's subject and action, the chosen medium and treatment, and the brand's own palette. It also reserves
 * the area the layout puts text in. Posts planned before art direction keep the older prompt in creative.ts.
 */
import type { ArtBrief, PaletteUse, PictureMedium } from './art-brief.ts';
import type { Brand } from './content.ts';
import { CANVAS_SIZE } from './layout.ts';
import type { Rect, SlotDefinition } from './layout-registry.ts';

const LOOKS: Readonly<Record<PictureMedium, string>> = {
  illustration: 'Flat geometric vector illustration, bold simple shapes, subtle grain, editorial poster style',
  'still-life': 'Minimal studio still life on a seamless backdrop, dramatic rim light, soft haze, cinematic product photography',
  isometric: 'Isometric 3D render, clean soft studio lighting, subtle depth, modern brand illustration',
  'photo-like': 'Natural-looking photograph, realistic lighting, shallow depth of field, candid and unposed',
  abstract: 'Abstract composition of layered shapes and soft gradients, calm and modern',
  diagram: 'Clean conceptual diagram made of simple shapes and connectors, purely schematic',
};

const SAFETY =
  'Keep every surface, sign and screen blank or abstract: no readable text, letters, numbers, logos, charts with values, certificates, awards or invented interface details. ' +
  'This is an illustrative concept, not a depiction of a real product screen, place or credential';

/** The smallest rectangle that holds every text slot of a zone. */
export function textRegion(slots: readonly SlotDefinition[]): Rect | undefined {
  if (slots.length === 0) return undefined;
  const x0 = Math.min(...slots.map((s) => s.rect.x));
  const y0 = Math.min(...slots.map((s) => s.rect.y));
  const x1 = Math.max(...slots.map((s) => s.rect.x + s.rect.w));
  const y1 = Math.max(...slots.map((s) => s.rect.y + s.rect.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const percent = (value: number): number => Math.round((value / CANVAS_SIZE) * 100);

/** Describes where the text goes in words an image model follows, from the real slot geometry. */
export function describeRegion(region: Rect): string {
  const centreX = (region.x + region.w / 2) / CANVAS_SIZE;
  const centreY = (region.y + region.h / 2) / CANVAS_SIZE;
  const horizontal = region.w / CANVAS_SIZE >= 0.8 ? 'full-width' : centreX < 0.4 ? 'left' : centreX > 0.6 ? 'right' : 'central';
  const vertical = centreY < 0.4 ? 'upper' : centreY > 0.6 ? 'lower' : 'middle';
  const place = horizontal === 'full-width' ? `${vertical} band` : `${vertical} ${horizontal} part`;
  return `the ${place} of the frame (about ${percent(region.w)}% wide and ${percent(region.h)}% tall)`;
}

function palette(use: PaletteUse, colors: Brand['colors']): string {
  const { ink, accent } = colors;
  if (use === 'accent-led') return `Palette: ${accent} as the dominant colour, supported by deep ${ink} and off-white`;
  if (use === 'ink-led') return `Palette: mostly deep ${ink}, with ${accent} as a small bright highlight, plus off-white`;
  return `Palette: deep ${ink} and ${accent} in balance, plus off-white`;
}

export interface ImagePromptInput {
  brief: ArtBrief;
  brand: Pick<Brand, 'colors'>;
  /** The text slots of the zone the brief chose. */
  textSlots: readonly SlotDefinition[];
}

/** The prompt for a post's picture, or undefined when the brief wants no picture, so no image is ever requested for it. */
export function buildImagePrompt({ brief, brand, textSlots }: ImagePromptInput): string | undefined {
  const { picture } = brief;
  if (picture.role === 'none') return undefined;
  const subject = picture.subject.replace(/[.\s]+$/, '');
  const action = picture.action.replace(/[.\s]+$/, '');
  const idea =
    picture.role === 'texture'
      ? `a subtle background texture suggested by ${subject}, with no single focal subject`
      : `${subject}, ${action}`;
  const region = textRegion(textSlots);
  const room = region ? `Leave ${describeRegion(region)} calm, low in detail and free of the subject, because text is placed there.` : '';
  return [
    `${LOOKS[picture.medium]}: ${idea}.`,
    `Setting: ${picture.scene.replace(/[.\s]+$/, '')}. Composition: ${picture.composition.replace(/[.\s]+$/, '')}. Mood: ${picture.mood.replace(/[.\s]+$/, '')}.`,
    ...(picture.role === 'hero' ? ['Give the scene real depth: a foreground, a midground and a background, one clear focal subject, and a single consistent light source with soft shadows.'] : []),
    `${palette(picture.paletteUse, brand.colors)}.`,
    room,
    `${SAFETY}.`,
  ]
    .filter(Boolean)
    .join(' ');
}
