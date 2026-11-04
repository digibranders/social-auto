/**
 * The art-direction brief: the structured answer an art director gives for one accepted post. It names a layout family,
 * how the text is arranged and what the picture shows, and nothing else. It never carries colours, coordinates, CSS,
 * accent words or copy: brand tokens, geometry and approved text belong to code. A brief is checked against the layout
 * registry (layout-registry.ts) before anything is drawn.
 */

/** Output ratios the schema names. Only the square is built and validated in v1. */
export const RATIOS = ['1:1', '4:5', '9:16'] as const;
export type Ratio = (typeof RATIOS)[number];

export const HIERARCHIES = ['headline-first', 'figure-first', 'list-first', 'picture-first'] as const;
export const HEADLINE_SCALES = ['small', 'medium', 'large', 'xl'] as const;
export const ALIGNMENTS = ['start', 'center'] as const;
export const TEXT_ZONES = ['top', 'bottom', 'left', 'right', 'center'] as const;
export const PICTURE_ROLES = ['none', 'hero', 'supporting', 'texture'] as const;
export const PICTURE_MEDIUMS = ['illustration', 'still-life', 'isometric', 'photo-like', 'abstract', 'diagram'] as const;
export const PALETTE_USES = ['ink-led', 'accent-led', 'balanced'] as const;

export type Hierarchy = (typeof HIERARCHIES)[number];
export type HeadlineScale = (typeof HEADLINE_SCALES)[number];
export type Alignment = (typeof ALIGNMENTS)[number];
export type TextZone = (typeof TEXT_ZONES)[number];
export type PictureRole = (typeof PICTURE_ROLES)[number];
export type PictureMedium = (typeof PICTURE_MEDIUMS)[number];
export type PaletteUse = (typeof PALETTE_USES)[number];

/** What the picture shows. With role "none" there is no picture and no image is requested. */
export type PictureBrief =
  | { role: 'none' }
  | {
      role: Exclude<PictureRole, 'none'>;
      medium: PictureMedium;
      /** From the accepted concept. */
      subject: string;
      /** From the accepted concept. */
      action: string;
      /** The setting and background around the subject. */
      scene: string;
      /** Camera angle and arrangement. */
      composition: string;
      mood: string;
      paletteUse: PaletteUse;
    };

export interface ArtBrief {
  /** A layout family id; whether it exists is the registry's question. */
  layout: string;
  hierarchy: Hierarchy;
  headlineScale: HeadlineScale;
  alignment: Alignment;
  textZone: TextZone;
  picture: PictureBrief;
  /** Slot ids from the chosen family's own lists. */
  logoSlot: string;
  identitySlot: string;
  ctaSlot: string;
}

const PICTURE_TEXT_LIMIT = 160;

export class ArtDirectionError extends Error {
  constructor(where: string, problem: string) {
    super(`${where}: ${problem}`);
    this.name = 'ArtDirectionError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function requireText(raw: Record<string, unknown>, key: string, where: string, field = key, limit?: number): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) throw new ArtDirectionError(where, `"${field}" must be non-empty text`);
  const text = value.trim();
  if (limit !== undefined && text.length > limit) throw new ArtDirectionError(where, `"${field}" is longer than ${limit} characters`);
  return text;
}

function requireOne<T extends string>(raw: Record<string, unknown>, key: string, allowed: readonly T[], where: string, field = key): T {
  const value = raw[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ArtDirectionError(where, `"${field}" must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function parsePicture(raw: unknown, where: string): PictureBrief {
  if (!isRecord(raw)) throw new ArtDirectionError(where, '"picture" must be an object');
  const role = requireOne(raw, 'role', PICTURE_ROLES, where, 'picture.role');
  if (role === 'none') return { role };
  const field = (key: string): string => requireText(raw, key, where, `picture.${key}`, PICTURE_TEXT_LIMIT);
  return {
    role,
    medium: requireOne(raw, 'medium', PICTURE_MEDIUMS, where, 'picture.medium'),
    subject: field('subject'),
    action: field('action'),
    scene: field('scene'),
    composition: field('composition'),
    mood: field('mood'),
    paletteUse: requireOne(raw, 'paletteUse', PALETTE_USES, where, 'picture.paletteUse'),
  };
}

/** Parses the art director's answer. Keys outside the contract are dropped, never passed on. */
export function parseArtBrief(raw: unknown, where: string): ArtBrief {
  if (!isRecord(raw)) throw new ArtDirectionError(where, 'the art direction must be an object');
  return {
    layout: requireText(raw, 'layout', where),
    hierarchy: requireOne(raw, 'hierarchy', HIERARCHIES, where),
    headlineScale: requireOne(raw, 'headlineScale', HEADLINE_SCALES, where),
    alignment: requireOne(raw, 'alignment', ALIGNMENTS, where),
    textZone: requireOne(raw, 'textZone', TEXT_ZONES, where),
    picture: parsePicture(raw['picture'], where),
    logoSlot: requireText(raw, 'logoSlot', where),
    identitySlot: requireText(raw, 'identitySlot', where),
    ctaSlot: requireText(raw, 'ctaSlot', where),
  };
}
