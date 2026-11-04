/**
 * The layout registry: what each poster composition is able to do. A family declares the text zones it supports and,
 * for each, where the headline, subline and picture go; where the logo, identity line and CTA may sit; what content it
 * needs; and the limits on text and picture. Code validates an art brief against its family (checkBriefAgainstFamily) and
 * resolves anything the brief leaves open. Geometry is for the 1080 square only in v1; other ratios need their own
 * recomposition and are named in the schema but not yet built. Families describe design capability, never an industry.
 */
import type { ArtBrief, HeadlineScale, PictureRole, Ratio, TextZone, Hierarchy, PictureMedium } from './art-brief.ts';
import { CANVAS_SIZE } from './layout.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlotDefinition {
  id: string;
  rect: Rect;
}

/** Material a family needs before it may be offered for a post. */
export type ContentNeed = 'list' | 'evidence' | 'offering';

export type ContrastStrategy = 'flat-dark' | 'solid-panel' | 'scrim' | 'plate';

export interface ZoneLayout {
  /** Includes a "headline" slot; may also hold "subline", "list" or "figure". */
  textSlots: SlotDefinition[];
  /** A picture slot is named for the picture role it serves: "hero", "supporting" or "texture". */
  imageSlots: SlotDefinition[];
}

export interface LayoutFamily {
  id: string;
  version: number;
  supportedRatios: Ratio[];
  allowedHierarchies: Hierarchy[];
  /** Headline scales the family supports, largest (preferred) first. */
  scales: HeadlineScale[];
  allowedPictureRoles: PictureRole[];
  /** When absent every medium is allowed. */
  allowedMediums?: PictureMedium[];
  requiredContent: ContentNeed[];
  zones: Partial<Record<TextZone, ZoneLayout>>;
  logoSlots: SlotDefinition[];
  identitySlots: SlotDefinition[];
  ctaSlots: SlotDefinition[];
  textConstraints: { maxLines: number; minFontSize: number; overflowPolicy: 'reflow' | 'reject' };
  imageConstraints: { focalRegion: 'center' | 'top' | 'bottom' | 'left' | 'right'; cropPolicy: 'cover' | 'contain'; protectText: boolean };
  contrastStrategies: ContrastStrategy[];
  fallbackFamily?: string;
}

/** The family that needs no content and no picture, so a fallback always exists. It cannot be switched off. */
export const SAFE_FAMILY = 'typography-hero';

const MARGIN = 64;
const FULL = CANVAS_SIZE;
const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const slot = (id: string, x: number, y: number, w: number, h: number): SlotDefinition => ({ id, rect: rect(x, y, w, h) });

const LOGO_TOP_LEFT = slot('top-left', MARGIN, 56, 420, 72);
const LOGO_TOP_RIGHT = slot('top-right', FULL - MARGIN - 420, 56, 420, 72);
const LOGO_BOTTOM_LEFT = slot('bottom-left', MARGIN, 944, 420, 72);
const IDENTITY_UNDER_LOGO = slot('under-logo', MARGIN, 140, 900, 48);
const IDENTITY_BOTTOM = slot('bottom-strip', MARGIN, 980, 900, 48);
const CTA_TOP_RIGHT = slot('top-right', FULL - MARGIN - 376, 56, 376, 60);
const CTA_BOTTOM_RIGHT = slot('bottom-right', FULL - MARGIN - 376, 968, 376, 56);
const CTA_BOTTOM_LEFT = slot('bottom-left', MARGIN, 968, 460, 56);

const WIDE = FULL - 2 * MARGIN;
const text = (...slots: SlotDefinition[]): SlotDefinition[] => slots;
const NO_IMAGE: SlotDefinition[] = [];
const FULL_IMAGE = (id: string): SlotDefinition => slot(id, 0, 0, FULL, FULL);

export const layoutRegistry: readonly LayoutFamily[] = [
  {
    id: 'typography-hero',
    version: 1,
    supportedRatios: ['1:1'],
    allowedHierarchies: ['headline-first'],
    scales: ['xl', 'large', 'medium'],
    allowedPictureRoles: ['none', 'texture'],
    allowedMediums: ['abstract', 'illustration'],
    requiredContent: [],
    zones: {
      top: { textSlots: text(slot('headline', MARGIN, 200, WIDE, 400), slot('subline', MARGIN, 620, WIDE, 150)), imageSlots: [FULL_IMAGE('texture')] },
      // The block of headline and subline sits a little below the middle of the canvas, which is the optical centre once the brand strip above it is counted.
      center: { textSlots: text(slot('headline', MARGIN, 310, WIDE, 420), slot('subline', MARGIN, 770, WIDE, 150)), imageSlots: [FULL_IMAGE('texture')] },
      // The lower-anchored variant is a light page, so a feed of picture-free posts is not all black; it takes no picture.
      bottom: { textSlots: text(slot('headline', MARGIN, 330, WIDE, 430), slot('subline', MARGIN, 800, WIDE, 150)), imageSlots: NO_IMAGE },
      // The light editorial variant: text starts clear of the accent rail on the canvas edge; no picture.
      left: { textSlots: text(slot('headline', 96, 250, WIDE - 32, 450), slot('subline', 96, 730, 800, 170)), imageSlots: NO_IMAGE },
    },
    logoSlots: [LOGO_TOP_LEFT, LOGO_TOP_RIGHT],
    identitySlots: [IDENTITY_UNDER_LOGO, IDENTITY_BOTTOM],
    ctaSlots: [CTA_TOP_RIGHT, CTA_BOTTOM_RIGHT],
    textConstraints: { maxLines: 4, minFontSize: 72, overflowPolicy: 'reflow' },
    imageConstraints: { focalRegion: 'center', cropPolicy: 'cover', protectText: true },
    contrastStrategies: ['flat-dark'],
  },
  {
    id: 'split-composition',
    version: 1,
    supportedRatios: ['1:1'],
    allowedHierarchies: ['headline-first', 'picture-first'],
    scales: ['large', 'medium', 'small'],
    allowedPictureRoles: ['hero'],
    requiredContent: [],
    zones: {
      left: { textSlots: text(slot('headline', MARGIN, 200, 460, 400), slot('subline', MARGIN, 640, 460, 200)), imageSlots: [slot('hero', 560, 0, 520, FULL)] },
      right: { textSlots: text(slot('headline', 556, 200, 460, 400), slot('subline', 556, 640, 460, 200)), imageSlots: [slot('hero', 0, 0, 520, FULL)] },
      top: { textSlots: text(slot('headline', MARGIN, 200, WIDE, 300), slot('subline', MARGIN, 520, WIDE, 120)), imageSlots: [slot('hero', 0, 680, FULL, 400)] },
      bottom: { textSlots: text(slot('headline', MARGIN, 470, WIDE, 300), slot('subline', MARGIN, 790, WIDE, 150)), imageSlots: [slot('hero', 0, 0, FULL, 420)] },
    },
    logoSlots: [LOGO_TOP_LEFT, LOGO_BOTTOM_LEFT],
    identitySlots: [IDENTITY_UNDER_LOGO, IDENTITY_BOTTOM],
    ctaSlots: [CTA_TOP_RIGHT, CTA_BOTTOM_LEFT],
    textConstraints: { maxLines: 5, minFontSize: 56, overflowPolicy: 'reflow' },
    imageConstraints: { focalRegion: 'center', cropPolicy: 'cover', protectText: false },
    contrastStrategies: ['solid-panel'],
    fallbackFamily: SAFE_FAMILY,
  },
  {
    id: 'full-bleed-editorial',
    version: 1,
    supportedRatios: ['1:1'],
    allowedHierarchies: ['picture-first', 'headline-first'],
    scales: ['large', 'medium', 'small'],
    allowedPictureRoles: ['hero'],
    requiredContent: [],
    zones: {
      top: { textSlots: text(slot('headline', MARGIN, 200, 800, 300), slot('subline', MARGIN, 520, 800, 120)), imageSlots: [FULL_IMAGE('hero')] },
      bottom: { textSlots: text(slot('headline', MARGIN, 560, 800, 280), slot('subline', MARGIN, 860, 800, 100)), imageSlots: [FULL_IMAGE('hero')] },
      left: { textSlots: text(slot('headline', MARGIN, 200, 520, 420), slot('subline', MARGIN, 660, 520, 200)), imageSlots: [FULL_IMAGE('hero')] },
    },
    logoSlots: [LOGO_TOP_LEFT, LOGO_TOP_RIGHT],
    identitySlots: [IDENTITY_UNDER_LOGO, IDENTITY_BOTTOM],
    ctaSlots: [CTA_TOP_RIGHT, CTA_BOTTOM_RIGHT],
    textConstraints: { maxLines: 4, minFontSize: 64, overflowPolicy: 'reflow' },
    imageConstraints: { focalRegion: 'center', cropPolicy: 'cover', protectText: true },
    contrastStrategies: ['scrim'],
    fallbackFamily: SAFE_FAMILY,
  },
  {
    id: 'feature-spotlight',
    version: 1,
    supportedRatios: ['1:1'],
    allowedHierarchies: ['headline-first', 'picture-first'],
    scales: ['large', 'medium', 'small'],
    allowedPictureRoles: ['hero'],
    allowedMediums: ['illustration', 'isometric', 'still-life', 'diagram', 'photo-like'],
    requiredContent: ['offering'],
    zones: {
      left: { textSlots: text(slot('headline', MARGIN, 220, 500, 340), slot('subline', MARGIN, 580, 500, 200)), imageSlots: [slot('hero', 600, 200, 416, 720)] },
      right: { textSlots: text(slot('headline', 516, 220, 500, 340), slot('subline', 516, 580, 500, 200)), imageSlots: [slot('hero', MARGIN, 200, 416, 720)] },
      bottom: { textSlots: text(slot('headline', MARGIN, 520, WIDE, 240), slot('subline', MARGIN, 780, WIDE, 140)), imageSlots: [slot('hero', MARGIN, 200, WIDE, 290)] },
    },
    logoSlots: [LOGO_TOP_LEFT, LOGO_TOP_RIGHT],
    identitySlots: [IDENTITY_UNDER_LOGO, IDENTITY_BOTTOM],
    ctaSlots: [CTA_TOP_RIGHT, CTA_BOTTOM_RIGHT],
    textConstraints: { maxLines: 4, minFontSize: 56, overflowPolicy: 'reflow' },
    imageConstraints: { focalRegion: 'center', cropPolicy: 'contain', protectText: false },
    contrastStrategies: ['solid-panel', 'scrim'],
    fallbackFamily: SAFE_FAMILY,
  },
  {
    id: 'structured-information',
    version: 1,
    supportedRatios: ['1:1'],
    allowedHierarchies: ['list-first', 'headline-first'],
    scales: ['large', 'medium', 'small'],
    allowedPictureRoles: ['none', 'supporting'],
    allowedMediums: ['diagram', 'abstract', 'illustration'],
    requiredContent: ['list'],
    zones: {
      top: {
        textSlots: text(slot('headline', MARGIN, 200, WIDE, 200), slot('subline', MARGIN, 410, WIDE, 100), slot('list', MARGIN, 530, WIDE, 420)),
        imageSlots: NO_IMAGE,
      },
      left: {
        textSlots: text(slot('headline', MARGIN, 200, 440, 340), slot('subline', MARGIN, 560, 440, 200), slot('list', 540, 200, 476, 750)),
        imageSlots: [slot('supporting', MARGIN, 780, 440, 170)],
      },
    },
    logoSlots: [LOGO_TOP_LEFT, LOGO_TOP_RIGHT],
    identitySlots: [IDENTITY_UNDER_LOGO, IDENTITY_BOTTOM],
    ctaSlots: [CTA_TOP_RIGHT, CTA_BOTTOM_RIGHT],
    textConstraints: { maxLines: 3, minFontSize: 52, overflowPolicy: 'reject' },
    imageConstraints: { focalRegion: 'center', cropPolicy: 'contain', protectText: true },
    contrastStrategies: ['solid-panel', 'flat-dark'],
    fallbackFamily: SAFE_FAMILY,
  },
  {
    id: 'evidence-spotlight',
    version: 1,
    supportedRatios: ['1:1'],
    allowedHierarchies: ['figure-first', 'headline-first'],
    scales: ['large', 'medium', 'small'],
    allowedPictureRoles: ['none', 'texture', 'supporting'],
    allowedMediums: ['abstract', 'illustration'],
    requiredContent: ['evidence'],
    zones: {
      center: {
        textSlots: text(slot('figure', MARGIN, 230, WIDE, 300), slot('headline', MARGIN, 560, WIDE, 220), slot('subline', MARGIN, 800, WIDE, 130)),
        imageSlots: [FULL_IMAGE('texture')],
      },
      left: {
        textSlots: text(slot('figure', MARGIN, 230, 500, 300), slot('headline', MARGIN, 560, 500, 220), slot('subline', MARGIN, 800, 500, 130)),
        imageSlots: [FULL_IMAGE('texture'), slot('supporting', 640, 200, 376, 640)],
      },
    },
    logoSlots: [LOGO_TOP_LEFT, LOGO_TOP_RIGHT],
    identitySlots: [IDENTITY_UNDER_LOGO, IDENTITY_BOTTOM],
    ctaSlots: [CTA_TOP_RIGHT, CTA_BOTTOM_RIGHT],
    textConstraints: { maxLines: 3, minFontSize: 56, overflowPolicy: 'reflow' },
    imageConstraints: { focalRegion: 'center', cropPolicy: 'cover', protectText: true },
    contrastStrategies: ['flat-dark', 'scrim'],
    fallbackFamily: SAFE_FAMILY,
  },
];

export function familyById(registry: readonly LayoutFamily[], id: string): LayoutFamily | undefined {
  return registry.find((family) => family.id === id);
}

/** The families a tenant may use: all of them except those it switched off. The safe family always stays. */
export function enabledFamilies(registry: readonly LayoutFamily[], settings: { disabled?: readonly string[] }): LayoutFamily[] {
  const disabled = new Set(settings.disabled ?? []);
  return registry.filter((family) => family.id === SAFE_FAMILY || !disabled.has(family.id));
}

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inCanvas = ({ x, y, w, h }: Rect): boolean => w > 0 && h > 0 && x >= 0 && y >= 0 && x + w <= CANVAS_SIZE && y + h <= CANVAS_SIZE;

/** True when the three chosen brand elements neither touch each other nor any text slot of the zone. */
export function seatedCleanly(zone: ZoneLayout, logo: SlotDefinition, identity: SlotDefinition, cta: SlotDefinition): boolean {
  const brand = [logo.rect, identity.rect, cta.rect];
  for (let i = 0; i < brand.length; i++) {
    for (let j = i + 1; j < brand.length; j++) if (overlaps(brand[i] as Rect, brand[j] as Rect)) return false;
  }
  return brand.every((placed) => zone.textSlots.every((textSlot) => !overlaps(placed, textSlot.rect)));
}

/** True when the slot lies over a hero or supporting picture of the zone, where it could hide part of the subject. */
export function coversPicture(zone: ZoneLayout, placed: SlotDefinition): boolean {
  return zone.imageSlots.some((image) => image.id !== 'texture' && overlaps(placed.rect, image.rect));
}

/** Reports every way the registry itself is inconsistent; an empty list means it can be trusted. */
export function validateRegistry(registry: readonly LayoutFamily[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const family of registry) {
    const label = `family "${family.id}"`;
    if (seen.has(family.id)) problems.push(`duplicate family id "${family.id}"`);
    seen.add(family.id);
    for (const ratio of family.supportedRatios) if (ratio !== '1:1') problems.push(`${label}: has no geometry for ratio ${ratio}`);
    if (family.allowedHierarchies.length === 0) problems.push(`${label}: allows no hierarchy`);
    if (family.scales.length === 0) problems.push(`${label}: supports no headline scale`);
    if (Object.keys(family.zones).length === 0) problems.push(`${label}: has no text zone`);

    const brandSlots = [...family.logoSlots, ...family.identitySlots, ...family.ctaSlots];
    for (const brandSlot of brandSlots) if (!inCanvas(brandSlot.rect)) problems.push(`${label} slot "${brandSlot.id}" is outside the canvas`);
    if (family.logoSlots.length === 0 || family.identitySlots.length === 0 || family.ctaSlots.length === 0) {
      problems.push(`${label}: needs at least one logo, identity and CTA slot`);
    }

    const servedRoles = new Set<string>();
    for (const [zoneName, zone] of Object.entries(family.zones) as [TextZone, ZoneLayout][]) {
      const where = `${label} zone "${zoneName}"`;
      if (!zone.textSlots.some((s) => s.id === 'headline')) problems.push(`${where}: has no headline slot`);
      for (const s of [...zone.textSlots, ...zone.imageSlots]) if (!inCanvas(s.rect)) problems.push(`${where} slot "${s.id}" is outside the canvas`);
      for (let i = 0; i < zone.textSlots.length; i++) {
        for (let j = i + 1; j < zone.textSlots.length; j++) {
          const a = zone.textSlots[i] as SlotDefinition;
          const b = zone.textSlots[j] as SlotDefinition;
          if (overlaps(a.rect, b.rect)) problems.push(`${where}: text slots "${a.id}" and "${b.id}" overlap`);
        }
      }
      for (const image of zone.imageSlots) servedRoles.add(image.id);
      const clean = family.logoSlots.some((logo) =>
        family.identitySlots.some((identity) => family.ctaSlots.some((cta) => seatedCleanly(zone, logo, identity, cta))),
      );
      if (!clean) problems.push(`${where}: no collision-free placement for the logo, identity line and CTA`);
    }
    for (const role of family.allowedPictureRoles) {
      if (role !== 'none' && !servedRoles.has(role)) problems.push(`${label}: allows picture role "${role}" but no zone has a "${role}" slot`);
    }
  }

  for (const family of registry) {
    if (family.fallbackFamily === undefined) continue;
    const label = `family "${family.id}"`;
    const next = familyById(registry, family.fallbackFamily);
    if (!next) {
      problems.push(`${label}: fallback "${family.fallbackFamily}" is not a family`);
      continue;
    }
    if (next.requiredContent.length > 0) problems.push(`${label}: fallback "${next.id}" needs content, so it is not a safe fallback`);
    const path = new Set<string>([family.id]);
    for (let step: LayoutFamily | undefined = next; step; step = step.fallbackFamily ? familyById(registry, step.fallbackFamily) : undefined) {
      if (path.has(step.id)) {
        problems.push(`${label}: fallback chain loops back to "${step.id}" (cycle)`);
        break;
      }
      path.add(step.id);
    }
  }

  const safe = familyById(registry, SAFE_FAMILY);
  if (!safe) problems.push(`the safe family "${SAFE_FAMILY}" is missing`);
  else if (safe.requiredContent.length > 0) problems.push(`the safe family "${SAFE_FAMILY}" must need no content`);
  return problems;
}

export type BriefProblemKind =
  | 'unknown_layout'
  | 'unsupported_ratio'
  | 'hierarchy_not_allowed'
  | 'scale_not_allowed'
  | 'text_zone_not_allowed'
  | 'picture_role_not_allowed'
  | 'picture_medium_not_allowed'
  | 'no_image_slot'
  | 'unknown_slot'
  | 'slot_collision';

export interface BriefProblem {
  kind: BriefProblemKind;
  message: string;
}

export interface BriefCheck {
  ok: boolean;
  problems: BriefProblem[];
}

/**
 * Checks a brief against its family. These are structural facts, not taste: every problem is one the resolver can act
 * on (choose another zone, slot or family) or that fails the post before any picture is made.
 */
export function checkBriefAgainstFamily(brief: ArtBrief, registry: readonly LayoutFamily[], ratio: Ratio = '1:1'): BriefCheck {
  const family = familyById(registry, brief.layout);
  if (!family) return { ok: false, problems: [{ kind: 'unknown_layout', message: `"${brief.layout}" is not an available layout` }] };

  const problems: BriefProblem[] = [];
  const add = (kind: BriefProblemKind, message: string): number => problems.push({ kind, message: `${family.id}: ${message}` });

  if (!family.supportedRatios.includes(ratio)) add('unsupported_ratio', `ratio ${ratio} is not supported`);
  if (!family.allowedHierarchies.includes(brief.hierarchy)) add('hierarchy_not_allowed', `hierarchy "${brief.hierarchy}" is not allowed`);
  if (!family.scales.includes(brief.headlineScale)) add('scale_not_allowed', `headline scale "${brief.headlineScale}" is not supported`);

  const zone = family.zones[brief.textZone];
  if (!zone) add('text_zone_not_allowed', `text zone "${brief.textZone}" is not available`);

  const { picture } = brief;
  if (!family.allowedPictureRoles.includes(picture.role)) {
    add('picture_role_not_allowed', `picture role "${picture.role}" is not allowed`);
  } else if (picture.role !== 'none') {
    if (family.allowedMediums && !family.allowedMediums.includes(picture.medium)) {
      add('picture_medium_not_allowed', `picture medium "${picture.medium}" is not allowed`);
    }
    if (zone && !zone.imageSlots.some((s) => s.id === picture.role)) {
      add('no_image_slot', `text zone "${brief.textZone}" has no "${picture.role}" picture slot`);
    }
  }

  const logo = family.logoSlots.find((s) => s.id === brief.logoSlot);
  const identity = family.identitySlots.find((s) => s.id === brief.identitySlot);
  const cta = family.ctaSlots.find((s) => s.id === brief.ctaSlot);
  if (!logo) add('unknown_slot', `logo slot "${brief.logoSlot}" does not exist`);
  if (!identity) add('unknown_slot', `identity slot "${brief.identitySlot}" does not exist`);
  if (!cta) add('unknown_slot', `CTA slot "${brief.ctaSlot}" does not exist`);
  if (zone && logo && identity && cta && !seatedCleanly(zone, logo, identity, cta)) {
    add('slot_collision', `logo "${logo.id}", identity "${identity.id}" and CTA "${cta.id}" collide with each other or with the text`);
  }
  return { ok: problems.length === 0, problems };
}
