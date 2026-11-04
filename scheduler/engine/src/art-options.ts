/**
 * Which art directions are open to a post, and which of them to put in front of the art director. Three separate ideas:
 * eligibility decides what can work (the post has the content a layout needs); suitability decides what should work (the
 * content calls for it); diversity decides among good alternatives (the brand's recent posters). Everything here is
 * deterministic and takes the brand's history as an argument, so tenants cannot leak into each other and no model or
 * image call is needed.
 */
import { extractFacts, stem } from './claims.ts';
import type { Hierarchy, PictureMedium, PictureRole, TextZone } from './art-brief.ts';
import type { Brand, PlannedPost } from './content.ts';
import { normalizeHeadline } from './hooks.ts';
import {
  SAFE_FAMILY,
  enabledFamilies,
  layoutRegistry,
  familyById,
  seatedCleanly,
  type ContentNeed,
  type LayoutFamily,
  type ZoneLayout,
} from './layout-registry.ts';

/** What an accepted post offers a layout. Only approved copy and verified material, never anything the art director adds. */
export interface PostFacts {
  /** With |accent| markers. */
  headline: string;
  subline: string;
  /** Distinct, validated items intended for display. */
  listItems: readonly string[];
  /** A verified figure the post's own copy states, for a large-figure layout. */
  figure?: string;
  /** A verified, attributable quotation. */
  quote?: string;
  /** The post concerns an offering the brand profile states. */
  concernsOffering: boolean;
}

/** One recorded art direction of an accepted (or provisionally chosen) post. */
export interface ArtRecord {
  layout: string;
  hierarchy: Hierarchy;
  textZone: TextZone;
  pictureRole: PictureRole;
  pictureMedium?: PictureMedium;
  logoSlot?: string;
  ctaSlot?: string;
}

export type Fit = 'likely_fit' | 'uncertain_fit' | 'likely_overflow';

export interface ArtOption {
  layout: string;
  zone: TextZone;
  hierarchy: Hierarchy;
  pictureRole: PictureRole;
  /** The family's allowed mediums (empty with no picture), least recently used first once scored. */
  mediums: PictureMedium[];
  fit: Fit;
}

export interface ScoredOption extends ArtOption {
  score: number;
  parts: { suitability: number; deficit: number; repetition: number; composition: number; fit: number };
}

export interface IneligibleFamily {
  layout: string;
  reason: string;
}

/** Tunable numbers. Starting values to be checked against real feeds, not universal constants. */
export interface ArtSettings {
  /** Family ids a tenant switched off; the safe family stays. */
  disabled?: readonly string[];
  /** Relative share each family should get; default 1, 0 switches it off. */
  familyWeights?: Readonly<Record<string, number>>;
  /** Accepted posts that count towards usage shares. */
  usageWindow?: number;
  deficitGain?: number;
  maxDeficit?: number;
  repeatPrevious?: number;
  repeatRecent?: number;
  sameZone?: number;
  sameHierarchy?: number;
  sameRole?: number;
  fitPenalty?: Readonly<Record<Fit, number>>;
  contentBonus?: Readonly<Record<ContentNeed, number>>;
  hierarchyBonus?: number;
  typeLedBonus?: number;
  shortHeadlineChars?: number;
  /** Average glyph width as a share of the font size, for scripts written with Latin letters and for others. */
  glyphWidth?: number;
  nonLatinGlyphWidth?: number;
  sublineFontSize?: number;
  sublineMaxLines?: number;
  mediumWindow?: number;
}

export const defaultArtSettings: Required<Omit<ArtSettings, 'disabled' | 'familyWeights'>> = {
  usageWindow: 14,
  deficitGain: 0.5,
  maxDeficit: 0.15,
  repeatPrevious: 0.3,
  repeatRecent: 0.1,
  sameZone: 0.1,
  sameHierarchy: 0.08,
  sameRole: 0.05,
  fitPenalty: { likely_fit: 0, uncertain_fit: 0.1, likely_overflow: 0.5 },
  contentBonus: { list: 0.5, evidence: 0.5, offering: 0.25 },
  hierarchyBonus: 0.25,
  typeLedBonus: 0.3,
  shortHeadlineChars: 28,
  glyphWidth: 0.55,
  nonLatinGlyphWidth: 1,
  sublineFontSize: 30,
  sublineMaxLines: 3,
  mediumWindow: 3,
};

const resolve = (settings: ArtSettings): typeof defaultArtSettings & ArtSettings => ({ ...defaultArtSettings, ...settings });

const plain = (text: string): string => text.replaceAll('|', '').trim();
const words = (text: string): string[] => normalizeHeadline(text).split(' ').filter((w) => w.length >= 5).map(stem);

/** The facts a layout can use from one accepted post. A figure counts only when the verified anchor and the post's own copy both state it. */
export function postFacts(post: PlannedPost, brand: Pick<Brand, 'offer' | 'features' | 'proofPoints'>): PostFacts {
  const listItems: string[] = [];
  const seen = new Set<string>();
  for (const item of post.listItems ?? []) {
    const key = normalizeHeadline(item);
    if (key && !seen.has(key)) {
      seen.add(key);
      listItems.push(item.trim());
    }
  }

  let figure: string | undefined;
  const anchor = post.anchor?.trim();
  if (anchor && brand.proofPoints.some((point) => point.trim().toLowerCase() === anchor.toLowerCase())) {
    const fromAnchor = extractFacts(anchor);
    const fromCopy = extractFacts(`${plain(post.headline)} ${plain(post.subline)}`);
    const stated = new Set([...fromCopy.prices, ...fromCopy.numbers]);
    figure = [...fromAnchor.prices, ...fromAnchor.numbers].find((value) => stated.has(value));
  }

  const offerWords = new Set(words([brand.offer, ...brand.features.map((f) => f.title)].join(' ')));
  const postWords = words([post.headline, post.subline, post.concept?.subject ?? '', post.concept?.message ?? ''].join(' '));
  const concernsOffering = brand.offer.trim().length > 0 && postWords.some((w) => offerWords.has(w));

  return { headline: post.headline, subline: post.subline, listItems, ...(figure ? { figure } : {}), concernsOffering };
}

const isNonLatin = (text: string): boolean => [...text].some((c) => /\p{L}/u.test(c) && !/\p{Script=Latin}/u.test(c));

function linesNeeded(text: string, charsPerLine: number): number {
  const cpl = Math.max(1, charsPerLine);
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const length = [...word].length;
    if (used > 0 && used + 1 + length <= cpl) {
      used += 1 + length;
      continue;
    }
    if (used > 0) lines += 1;
    const extra = Math.ceil(length / cpl) - 1;
    lines += extra;
    used = extra > 0 ? length - extra * cpl : length;
  }
  return lines;
}

function fitOf(text: string, rect: { w: number; h: number }, fontSize: number, lineHeight: number, maxLines: number, s: typeof defaultArtSettings): Fit {
  const content = plain(text);
  if (!content) return 'likely_fit';
  const nonLatin = isNonLatin(content);
  const glyph = (nonLatin ? s.nonLatinGlyphWidth : s.glyphWidth) * fontSize;
  const allowed = Math.max(1, Math.min(maxLines, Math.floor(rect.h / (fontSize * lineHeight))));
  const ratio = linesNeeded(content, Math.floor(rect.w / glyph)) / allowed;
  if (ratio <= 0.75) return nonLatin ? 'uncertain_fit' : 'likely_fit';
  if (ratio <= 1) return 'uncertain_fit';
  // Without real font metrics a non-Latin script is never called an overflow.
  return nonLatin ? 'uncertain_fit' : 'likely_overflow';
}

const FIT_ORDER: Fit[] = ['likely_fit', 'uncertain_fit', 'likely_overflow'];

/** A rough, advisory fit of the post's text in a zone at the family's smallest font size. Real fit is measured when the poster is rendered. */
export function estimateFit(post: Pick<PostFacts, 'headline' | 'subline'>, family: LayoutFamily, zone: ZoneLayout, settings: ArtSettings): Fit {
  const s = resolve(settings);
  const results: Fit[] = [];
  const headline = zone.textSlots.find((slot) => slot.id === 'headline');
  if (headline) results.push(fitOf(post.headline, headline.rect, family.textConstraints.minFontSize, 1, family.textConstraints.maxLines, s));
  const subline = zone.textSlots.find((slot) => slot.id === 'subline');
  if (subline) results.push(fitOf(post.subline, subline.rect, s.sublineFontSize, 1.3, s.sublineMaxLines, s));
  return results.reduce<Fit>((worst, next) => (FIT_ORDER.indexOf(next) > FIT_ORDER.indexOf(worst) ? next : worst), 'likely_fit');
}

function missingContent(family: LayoutFamily, post: PostFacts): string | undefined {
  for (const need of family.requiredContent) {
    if (need === 'list' && post.listItems.length < 2) return 'needs at least two distinct list items';
    if (need === 'evidence' && !post.figure && !post.quote) return 'needs a verified figure or quotation';
    if (need === 'offering' && !post.concernsOffering) return 'needs a post that concerns a verified offering';
  }
  return undefined;
}

function hierarchyAllowed(hierarchy: Hierarchy, role: PictureRole, zone: ZoneLayout, post: PostFacts): boolean {
  if (hierarchy === 'picture-first') return role !== 'none';
  if (hierarchy === 'list-first') return post.listItems.length >= 2 && zone.textSlots.some((slot) => slot.id === 'list');
  if (hierarchy === 'figure-first') return Boolean(post.figure) && zone.textSlots.some((slot) => slot.id === 'figure');
  return true;
}

/** Everything open to a post: one option per family, zone, hierarchy and picture role it can use, and the families that cannot be used, with reasons. */
export function eligibleOptions(
  post: PostFacts,
  registry: readonly LayoutFamily[],
  settings: ArtSettings,
): { options: ArtOption[]; ineligible: IneligibleFamily[] } {
  const weights = settings.familyWeights ?? {};
  const open = enabledFamilies(registry, { disabled: settings.disabled ?? [] });
  const options: ArtOption[] = [];
  const ineligible: IneligibleFamily[] = [];
  for (const family of registry) {
    if (!open.includes(family)) {
      ineligible.push({ layout: family.id, reason: 'switched off for this brand' });
      continue;
    }
    if (family.id !== SAFE_FAMILY && (weights[family.id] ?? 1) <= 0) {
      ineligible.push({ layout: family.id, reason: 'weight 0 for this brand' });
      continue;
    }
    const missing = missingContent(family, post);
    if (missing) {
      ineligible.push({ layout: family.id, reason: missing });
      continue;
    }
    const before = options.length;
    for (const [zoneName, zone] of Object.entries(family.zones) as [TextZone, ZoneLayout][]) {
      const fit = estimateFit(post, family, zone, settings);
      const roles = family.allowedPictureRoles.filter((role) => role === 'none' || zone.imageSlots.some((slot) => slot.id === role));
      for (const hierarchy of family.allowedHierarchies) {
        for (const role of roles) {
          if (!hierarchyAllowed(hierarchy, role, zone, post)) continue;
          options.push({ layout: family.id, zone: zoneName, hierarchy, pictureRole: role, mediums: role === 'none' ? [] : [...(family.allowedMediums ?? ALL_MEDIUMS)], fit });
        }
      }
    }
    if (options.length === before) ineligible.push({ layout: family.id, reason: 'no zone can show this post' });
  }
  return { options, ineligible };
}

const ALL_MEDIUMS: readonly PictureMedium[] = ['illustration', 'still-life', 'isometric', 'photo-like', 'abstract', 'diagram'];

const round = (value: number): number => Math.round(value * 1e6) / 1e6;
const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

function suitability(option: ArtOption, family: LayoutFamily | undefined, post: PostFacts, s: typeof defaultArtSettings): number {
  let total = 0;
  for (const need of family?.requiredContent ?? []) {
    if (need === 'list' && post.listItems.length >= 2) total += s.contentBonus.list;
    if (need === 'evidence' && (post.figure || post.quote)) total += s.contentBonus.evidence;
    if (need === 'offering' && post.concernsOffering) total += s.contentBonus.offering;
  }
  if (option.hierarchy === 'list-first' && post.listItems.length >= 2) total += s.hierarchyBonus;
  if (option.hierarchy === 'figure-first' && post.figure) total += s.hierarchyBonus;
  const typeLed = option.pictureRole === 'none' || option.pictureRole === 'texture';
  if (typeLed && [...plain(post.headline)].length <= s.shortHeadlineChars) total += s.typeLedBonus;
  return Math.min(total, 0.9);
}

/** Least recently used first among the mediums, so a repeat is never blocked, only put last. */
function orderMediums(mediums: readonly PictureMedium[], history: readonly ArtRecord[], window: number): PictureMedium[] {
  const recent = history.slice(-window);
  const lastUse = (medium: PictureMedium): number => {
    for (let i = recent.length - 1; i >= 0; i--) if (recent[i]?.pictureMedium === medium) return i;
    return -1;
  };
  return [...mediums].sort((a, b) => lastUse(a) - lastUse(b));
}

/**
 * Scores options as suitability + deficit - repetition - composition - fit. Suitability comes from what the post contains,
 * the deficit from how far each family is below its weighted share of the brand's recent posters, repetition from recent
 * use of the same family, composition from the same zone, hierarchy and picture role as the previous poster. Options come
 * back best first; ties keep registry order.
 */
export function scoreOptions(
  options: readonly ArtOption[],
  post: PostFacts,
  history: readonly ArtRecord[],
  settings: ArtSettings,
  registry: readonly LayoutFamily[],
): ScoredOption[] {
  const s = resolve(settings);
  const weights = settings.familyWeights ?? {};
  const layouts = [...new Set(options.map((o) => o.layout))];
  const weightOf = (id: string): number => (id === SAFE_FAMILY ? Math.max(weights[id] ?? 1, 0) || 1 : weights[id] ?? 1);
  const total = layouts.reduce((sum, id) => sum + weightOf(id), 0) || 1;
  const recent = history.slice(-s.usageWindow);
  const share = (id: string): number => recent.filter((r) => r.layout === id).length / (recent.length + 1);
  const previous = history[history.length - 1];

  const scored = options.map((option, index): ScoredOption & { index: number } => {
    const family = familyById(registry, option.layout);
    const suit = suitability(option, family, post, s);
    const deficit = clamp((weightOf(option.layout) / total - share(option.layout)) * s.deficitGain, s.maxDeficit);
    let repetition = 0;
    if (previous?.layout === option.layout) repetition += s.repeatPrevious;
    for (const back of [2, 3]) if (history[history.length - back]?.layout === option.layout) repetition += s.repeatRecent;
    let composition = 0;
    if (previous) {
      if (previous.textZone === option.zone) composition += s.sameZone;
      if (previous.hierarchy === option.hierarchy) composition += s.sameHierarchy;
      if (previous.pictureRole === option.pictureRole) composition += s.sameRole;
    }
    const fit = s.fitPenalty[option.fit];
    return {
      ...option,
      mediums: orderMediums(option.mediums, history, s.mediumWindow),
      score: round(suit + deficit - repetition - composition - fit),
      parts: { suitability: round(suit), deficit: round(deficit), repetition: round(repetition), composition: round(composition), fit },
      index,
    };
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(({ index: _index, ...rest }) => rest);
}

const compositionKey = (o: ArtOption): string => `${o.zone}|${o.hierarchy}|${o.pictureRole}`;

/**
 * Up to `size` options that really differ: the best one, the best from another family, then the best from a third family or,
 * failing that, one whose composition differs from those already picked. With one family eligible only its best option is
 * returned: variety is never forced.
 */
export function shortlistOf(scored: readonly ScoredOption[], size = 3): ScoredOption[] {
  const first = scored[0];
  if (!first || size < 1) return [];
  const picked: ScoredOption[] = [first];
  while (picked.length < size) {
    const families = new Set(picked.map((o) => o.layout));
    let next = scored.find((o) => !families.has(o.layout));
    if (!next && families.size > 1) {
      const taken = new Set(picked.map(compositionKey));
      next = scored.find((o) => !taken.has(compositionKey(o)));
    }
    if (!next) break;
    picked.push(next);
  }
  return picked;
}

/** The logo, identity and CTA slots for a zone: a clean combination, preferring one that does not repeat the last two placements. */
export function chooseBrandSlots(
  family: LayoutFamily,
  zoneName: TextZone,
  history: readonly ArtRecord[],
): { logoSlot: string; identitySlot: string; ctaSlot: string } | undefined {
  const zone = family.zones[zoneName];
  if (!zone) return undefined;
  const recent = history.slice(-2);
  let best: { logoSlot: string; identitySlot: string; ctaSlot: string; penalty: number } | undefined;
  for (const logo of family.logoSlots) {
    for (const identity of family.identitySlots) {
      for (const cta of family.ctaSlots) {
        if (!seatedCleanly(zone, logo, identity, cta)) continue;
        const penalty = recent.filter((r) => r.logoSlot === logo.id).length + recent.filter((r) => r.ctaSlot === cta.id).length;
        if (!best || penalty < best.penalty) best = { logoSlot: logo.id, identitySlot: identity.id, ctaSlot: cta.id, penalty };
      }
    }
  }
  return best && { logoSlot: best.logoSlot, identitySlot: best.identitySlot, ctaSlot: best.ctaSlot };
}

export interface PostOptions {
  eligible: ScoredOption[];
  ineligible: IneligibleFamily[];
  shortlist: ScoredOption[];
}

const recordOf = (option: ArtOption): ArtRecord => ({ layout: option.layout, hierarchy: option.hierarchy, textZone: option.zone, pictureRole: option.pictureRole });

/**
 * Shortlists for a weekly batch. Each post is scored against the brand's history plus the choices made for the posts
 * before it: the actual choice where `chosen` has one, otherwise the provisional top pick. Passing `chosen` again after
 * the art director answers re-plans the remaining posts from what was really used. Nothing is committed here.
 */
export function planShortlists(input: {
  posts: readonly PostFacts[];
  history: readonly ArtRecord[];
  registry?: readonly LayoutFamily[];
  settings?: ArtSettings;
  chosen?: ReadonlyArray<ArtRecord | undefined>;
  shortlistSize?: number;
}): PostOptions[] {
  const registry = input.registry ?? layoutRegistry;
  const settings = input.settings ?? {};
  const running: ArtRecord[] = [...input.history];
  return input.posts.map((post, i) => {
    const { options, ineligible } = eligibleOptions(post, registry, settings);
    const eligible = scoreOptions(options, post, running, settings, registry);
    const shortlist = shortlistOf(eligible, input.shortlistSize ?? 3);
    const top = shortlist[0];
    const pick = input.chosen?.[i] ?? (top ? recordOf(top) : undefined);
    if (pick) running.push(pick);
    return { eligible, ineligible, shortlist };
  });
}
