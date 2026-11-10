import { isNetwork, type PostVariants } from './networks.ts';
import type { PostOffer } from './offer.ts';
import { readFile } from 'node:fs/promises';
import { ArtDirectionError, HIERARCHIES, PICTURE_ROLES, TEXT_ZONES, parseArtBrief, type ArtBrief } from './art-brief.ts';
import type { ArtRecord } from './art-options.ts';
import { parseConcept, type Concept } from './concepts.ts';
import type { CallToAction } from './cta.ts';
import type { BrandIdentity } from './identity.ts';

export interface BrandColors {
  background: string;
  ink: string;
  accent: string;
  tile: string;
}

export type FeatureIcon = 'monitor' | 'gear' | 'person' | 'shield';

const FEATURE_ICONS: readonly FeatureIcon[] = ['monitor', 'gear', 'person', 'shield'];
const MAX_FEATURES = 3;

/** One item in the poster's bottom feature bar. */
export interface BrandFeature {
  icon: FeatureIcon;
  title: string;
  detail: string;
}

export const LOGO_KINDS = ['site-logo', 'site-icon', 'name-only'] as const;
export type LogoKind = (typeof LOGO_KINDS)[number];

/** Where a brand's logo came from, so a wrong one can be traced to the address it was taken from. */
export interface LogoSource {
  kind: LogoKind;
  /** The page the candidates were found on. */
  foundOn: string;
  /** The exact picture address that was used; null for a logo made from the name alone. */
  imageUrl: string | null;
  /** The file in the brand folder that holds the picture (the icon, when the logo was built around it); null for name-only. */
  savedAs: string | null;
  contentType: string | null;
  bytes: number | null;
  contentHash: string | null;
  fetchedAt: string;
  /** Every address tried, in order, with what happened. */
  tried: Array<{ url: string; outcome: string }>;
  /** Why this picture was taken for the business's own logo: where it sits, what says so, and whose domain serves it. Older profiles have none. */
  provenance?: { placement: string; signals: string[]; hostRelation: 'same_site' | 'third_party' };
}

/** The brand's own symbol without its name, taken from the site, and whether a model confirmed it is the same mark that appears in the logo. */
export interface LogoIcon {
  /** The file in the brand folder. */
  savedAs: string;
  imageUrl: string;
  contentType: string;
  contentHash: string;
  fetchedAt: string;
  /** True only when the symbol was checked against the logo and matches it; a generic favicon is never used as the brand's mark. */
  matchesLogo: boolean;
  /** What the check said, for a person to read. */
  reason?: string;
}

export interface Brand {
  name: string;
  website: string;
  handleUrl: string;
  offer: string;
  audience: string;
  tone: string;
  proofPoints: string[];
  callToAction: string;
  rules: string[];
  colors: BrandColors;
  font: string;
  logo: string;
  mark: string;
  features: BrandFeature[];
  /** One sentence for picture makers: the palette in words, the mood and setting, what to avoid. Older profiles have none. */
  visualStyle?: string;
  /** Where the logo was taken from. Older profiles have none. */
  logoSource?: LogoSource;
  /** The brand's symbol alone, when the site has one that matches its logo. Older profiles have none. */
  logoIcon?: LogoIcon;
  /** What the business is in one plain line, with the source that supports it. Older profiles have none. */
  identity?: BrandIdentity;
  /** The action the posters invite, and the link on the site that shows it is real. Older profiles have none. */
  cta?: CallToAction;
}

function requireStringArray(obj: Record<string, unknown>, key: string, source: string, allowEmpty = false): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || (value.length === 0 && !allowEmpty) || !value.every((v) => typeof v === 'string' && v.trim())) {
    throw new ContentValidationError(source, `"${key}" must be ${allowEmpty ? 'an array' : 'a non-empty array'} of strings`);
  }
  return value as string[];
}

export type ImageMode = 'template' | 'ai';

/** Where a poster puts its text. Posts rotate through these so a week does not look like one repeated image. */
export const LAYOUTS = ['left', 'bottom', 'right', 'dark'] as const;
export type LayoutName = (typeof LAYOUTS)[number];

export function isLayoutName(value: unknown): value is LayoutName {
  return typeof value === 'string' && (LAYOUTS as readonly string[]).includes(value);
}

/**
 * The kind of poster. Posts rotate through these so a week is not one repeated image: type-only (no picture), a flat
 * illustration, a studio still life and an isometric render. Plans written before formats existed have none and render as
 * the original photo poster.
 */
export const FORMATS = ['type', 'illustration', 'still-life', 'isometric'] as const;
export type FormatName = (typeof FORMATS)[number];

export function isFormatName(value: unknown): value is FormatName {
  return typeof value === 'string' && (FORMATS as readonly string[]).includes(value);
}

/** One art direction the renderer may try for a post: the brief, its image prompt (none without a picture) and the art record to commit if it renders. */
export interface PostArtCandidate {
  optionId: string;
  brief: ArtBrief;
  imagePrompt?: string;
  record: ArtRecord;
}

/** The art direction of a post: how it was resolved and the candidates in the order the renderer tries them (the first is the chosen one). */
export interface PostArt {
  resolution: 'directed' | 'repaired' | 'fallback';
  candidates: PostArtCandidate[];
  /** A verified figure or quotation the evidence layout may show large. */
  figure?: string;
  quote?: string;
  /** A usable commercial fact the evidence layout may show large, with its plan and condition. */
  offer?: PostOffer;
}

export interface PlannedPost {
  id: string;
  date: string;
  painPoint: string;
  mode: ImageMode;
  /** Text inside |pipes| is rendered in the accent colour. */
  headline: string;
  subline: string;
  imagePrompt?: string;
  /** Poster layout; plans written before layouts existed have none and render as 'left'. */
  layout?: LayoutName;
  /** Poster format; absent on plans written before formats existed. */
  format?: FormatName;
  /** The content pillar the post belongs to (problem, education, proof, ...); absent on older plans. */
  pillar?: string;
  /** The hook the headline was written with; when a fallback replaced it, `requestedHook` holds the hook that was assigned. */
  hook?: string;
  requestedHook?: string;
  /** Repetition and language notes from the hook checks; warnings, not failures. */
  hookWarnings?: string[];
  /** The items of a numbered-list headline, already part of the caption. */
  listItems?: string[];
  /** What the post is about and shows, kept in the brand's history so later posts do not repeat it. */
  concept?: Concept;
  /** The proof point the post was built on. */
  anchor?: string;
  /** A call to action chosen for this post alone (the brand's own does not fit its subject); the poster and the caption use it instead of the brand's. */
  cta?: CallToAction;
  /** Why the post's call to action differs from the brand's. */
  ctaReason?: string;
  /** Evidence facts assigned to the post by code, in the order given to the writer; used for review and for fact cooldown across weeks. */
  factIds?: string[];
  /** What was and was not checked against those facts, e.g. semantic_support_unverified. */
  evidenceChecks?: string[];
  /** The art direction (layout, picture, placements) for posts planned with the art director; older posts have none and render as before. */
  art?: PostArt;
  /** Why an art plan's post has no art direction; such a post is not rendered silently with the older renderer. */
  artFailure?: { reasons: string[] };
  /** Review state of an art-directed poster. */
  approval?: PostApproval;
  /** The older concept the post deliberately returns to with a different message. */
  revisitOf?: string;
  caption: string;
  hashtags: string[];
  /** A caption for each network the post is for, when the plan was written for networks; a network without one uses `caption`. */
  variants?: PostVariants;
}

/** How the posters of a plan are made. A plan names its mode: "art_v1" posts go through art direction and measured rendering and never fall back to the older renderer unless that was explicitly allowed. "ai_v1" posters are drawn whole by the picture model and are published only from an approved version in the review store (review-store.ts), never from the plan. Plans without a mode are "legacy". */
export type RenderMode = 'legacy' | 'art_v1' | 'ai_v1';

export interface WeekPlan {
  brand: string;
  timezone: string;
  renderMode?: RenderMode;
  posts: PlannedPost[];
}

/** Human review of an art-directed poster. A rendered poster is technically valid, not accepted: only approved posters are scheduled or exported. */
export interface PostApproval {
  status: 'pending' | 'approved' | 'rejected';
  at?: string;
  by?: string;
  reason?: string;
}

/** Whether a post may be scheduled or exported: every post of a legacy plan, only approved posts of an art plan. */
export function isPublishable(plan: Pick<WeekPlan, 'renderMode'>, post: Pick<PlannedPost, 'approval'>): boolean {
  // An "ai_v1" plan says nothing about approval: the plan file is mutable, so only an approved version in the review store can publish (see approvedAiPoster).
  if (plan.renderMode === 'ai_v1') return false;
  return (plan.renderMode ?? 'legacy') === 'legacy' || post.approval?.status === 'approved';
}

export class ContentValidationError extends Error {
  constructor(source: string, problem: string) {
    super(`${source}: ${problem}`);
    this.name = 'ContentValidationError';
  }
}

export const INSTAGRAM_CAPTION_LIMIT = 2200;
const INSTAGRAM_HASHTAG_LIMIT = 30;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, source: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ContentValidationError(source, `"${key}" must be a non-empty string`);
  }
  return value;
}

export function parseBrand(raw: unknown, source: string): Brand {
  if (!isRecord(raw)) throw new ContentValidationError(source, 'brand must be an object');
  const colors = raw['colors'];
  if (!isRecord(colors)) throw new ContentValidationError(source, '"colors" must be an object');
  const parsedColors: BrandColors = {
    background: requireString(colors, 'background', source),
    ink: requireString(colors, 'ink', source),
    accent: requireString(colors, 'accent', source),
    tile: requireString(colors, 'tile', source),
  };
  for (const [name, hex] of Object.entries(parsedColors)) {
    if (!HEX_COLOR.test(hex)) throw new ContentValidationError(source, `colors.${name} must be #RRGGBB`);
  }
  if (raw['visualStyle'] !== undefined && typeof raw['visualStyle'] !== 'string') {
    throw new ContentValidationError(source, '"visualStyle" must be text');
  }
  const visualStyle = typeof raw['visualStyle'] === 'string' && raw['visualStyle'].trim() ? raw['visualStyle'].trim().slice(0, 400) : undefined;
  return {
    ...(visualStyle ? { visualStyle } : {}),
    ...(raw['logoSource'] !== undefined ? { logoSource: parseLogoSource(raw['logoSource'], source) } : {}),
    ...(raw['logoIcon'] !== undefined ? { logoIcon: parseLogoIcon(raw['logoIcon'], source) } : {}),
    ...(raw['identity'] !== undefined ? { identity: parseIdentity(raw['identity'], source) } : {}),
    ...(raw['cta'] !== undefined ? { cta: parseCta(raw['cta'], source) } : {}),
    name: requireString(raw, 'name', source),
    website: requireString(raw, 'website', source),
    handleUrl: requireString(raw, 'handleUrl', source),
    offer: requireString(raw, 'offer', source),
    audience: requireString(raw, 'audience', source),
    tone: requireString(raw, 'tone', source),
    // Only claims the site really makes are kept (see claims.ts), so a site with nothing verifiable has none.
    proofPoints: requireStringArray(raw, 'proofPoints', source, true),
    callToAction: requireString(raw, 'callToAction', source),
    rules: requireStringArray(raw, 'rules', source),
    colors: parsedColors,
    font: requireString(raw, 'font', source),
    logo: requireString(raw, 'logo', source),
    mark: requireString(raw, 'mark', source),
    features: parseFeatures(raw['features'], source),
  };
}

function parseProvenance(raw: unknown, where: string): NonNullable<LogoSource['provenance']> {
  if (!isRecord(raw) || typeof raw['placement'] !== 'string' || !Array.isArray(raw['signals']) || !raw['signals'].every((x) => typeof x === 'string') || (raw['hostRelation'] !== 'same_site' && raw['hostRelation'] !== 'third_party')) {
    throw new ContentValidationError(where, '"logoSource.provenance" must be {placement, signals, hostRelation}');
  }
  return { placement: raw['placement'], signals: raw['signals'] as string[], hostRelation: raw['hostRelation'] };
}

function parseLogoSource(raw: unknown, source: string): LogoSource {
  const where = `${source} logoSource`;
  if (!isRecord(raw)) throw new ContentValidationError(where, '"logoSource" must be an object');
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(LOGO_KINDS as readonly string[]).includes(kind)) throw new ContentValidationError(where, `"logoSource.kind" must be one of ${LOGO_KINDS.join(', ')}`);
  const text = (key: string): string | null => {
    const value = raw[key];
    if (value === null) return null;
    if (typeof value !== 'string') throw new ContentValidationError(where, `"logoSource.${key}" must be text or null`);
    return value;
  };
  const bytes = raw['bytes'];
  if (bytes !== null && (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0)) throw new ContentValidationError(where, '"logoSource.bytes" must be a number or null');
  const tried = raw['tried'];
  if (!Array.isArray(tried) || !tried.every((t) => isRecord(t) && typeof t['url'] === 'string' && typeof t['outcome'] === 'string')) {
    throw new ContentValidationError(where, '"logoSource.tried" must be a list of {url, outcome}');
  }
  const foundOn = text('foundOn');
  const fetchedAt = text('fetchedAt');
  if (!foundOn || !fetchedAt) throw new ContentValidationError(where, '"logoSource" needs foundOn and fetchedAt');
  return {
    kind: kind as LogoKind,
    foundOn,
    imageUrl: text('imageUrl'),
    savedAs: text('savedAs'),
    contentType: text('contentType'),
    bytes: bytes as number | null,
    contentHash: text('contentHash'),
    fetchedAt,
    tried: (tried as Array<Record<string, string>>).map((t) => ({ url: t['url'] as string, outcome: t['outcome'] as string })),
    ...(raw['provenance'] === undefined ? {} : { provenance: parseProvenance(raw['provenance'], where) }),
  };
}

function parseLogoIcon(raw: unknown, source: string): LogoIcon {
  const where = `${source} logoIcon`;
  if (!isRecord(raw)) throw new ContentValidationError(where, '"logoIcon" must be an object');
  const text = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || !value.trim()) throw new ContentValidationError(where, `"logoIcon.${key}" must be text`);
    return value;
  };
  if (typeof raw['matchesLogo'] !== 'boolean') throw new ContentValidationError(where, '"logoIcon.matchesLogo" must be true or false');
  const reason = raw['reason'];
  if (reason !== undefined && typeof reason !== 'string') throw new ContentValidationError(where, '"logoIcon.reason" must be text');
  return { savedAs: text('savedAs'), imageUrl: text('imageUrl'), contentType: text('contentType'), contentHash: text('contentHash'), fetchedAt: text('fetchedAt'), matchesLogo: raw['matchesLogo'], ...(reason ? { reason } : {}) };
}

const IDENTITY_KINDS = ['approved', 'homepage', 'about', 'offering', 'metadata', 'name-only'];
const IDENTITY_STATUSES = ['verified', 'approved', 'unverified'];

function parseIdentity(raw: unknown, source: string): BrandIdentity {
  const where = `${source} identity`;
  if (!isRecord(raw)) throw new ContentValidationError(where, '"identity" must be an object');
  const { line, kind, verification } = raw;
  if (typeof line !== 'string' || !line.trim()) throw new ContentValidationError(where, '"identity.line" must be text');
  if (typeof kind !== 'string' || !IDENTITY_KINDS.includes(kind)) throw new ContentValidationError(where, `"identity.kind" must be one of ${IDENTITY_KINDS.join(', ')}`);
  if (!isRecord(verification) || typeof verification['status'] !== 'string' || !IDENTITY_STATUSES.includes(verification['status']) || !Array.isArray(verification['reasons']) || !verification['reasons'].every((r) => typeof r === 'string')) {
    throw new ContentValidationError(where, '"identity.verification" must give a status and reasons');
  }
  const src = raw['source'];
  if (src !== null && !(isRecord(src) && typeof src['url'] === 'string' && typeof src['verbatimQuote'] === 'string')) throw new ContentValidationError(where, '"identity.source" must be null or give a url and quote');
  const sourceRecord = src === null ? null : { url: (src as Record<string, string>)['url'] as string, verbatimQuote: (src as Record<string, string>)['verbatimQuote'] as string, fetchedAt: ((src as Record<string, unknown>)['fetchedAt'] as string | null | undefined) ?? null, contentHash: ((src as Record<string, unknown>)['contentHash'] as string | null | undefined) ?? null };
  const type = raw['type'];
  if (type !== undefined && type !== null && type !== 'descriptive' && type !== 'uncertain') throw new ContentValidationError(where, '"identity.type" must be descriptive, uncertain or null');
  return { line, kind: kind as BrandIdentity['kind'], type: (type as BrandIdentity['type'] | undefined) ?? null, source: sourceRecord, verification: { status: verification['status'] as BrandIdentity['verification']['status'], reasons: verification['reasons'] as string[] } };
}

export function parseCta(raw: unknown, source: string): CallToAction {
  const where = `${source} cta`;
  if (!isRecord(raw)) throw new ContentValidationError(where, '"cta" must be an object');
  const { kind, label, text, evidence } = raw;
  if (kind !== 'site-action' && kind !== 'visit-site') throw new ContentValidationError(where, '"cta.kind" must be site-action or visit-site');
  if (typeof label !== 'string' || typeof text !== 'string' || !label.trim() || !text.trim()) throw new ContentValidationError(where, '"cta" needs a label and text');
  if (evidence !== null && !(isRecord(evidence) && typeof evidence['url'] === 'string' && typeof evidence['linkText'] === 'string' && ['nav', 'body', 'footer'].includes(evidence['region'] as string))) {
    throw new ContentValidationError(where, '"cta.evidence" must be null or give linkText, url and region');
  }
  return { kind, label, text, evidence: evidence === null ? null : { linkText: (evidence as Record<string, string>)['linkText'] as string, url: (evidence as Record<string, string>)['url'] as string, region: (evidence as Record<string, string>)['region'] as 'nav' | 'body' | 'footer' } };
}

function parseFeatures(raw: unknown, source: string): BrandFeature[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FEATURES) {
    throw new ContentValidationError(source, `"features" must be an array of 1-${MAX_FEATURES} items`);
  }
  return raw.map((item, index) => {
    const where = `${source} features[${index}]`;
    if (!isRecord(item)) throw new ContentValidationError(where, 'feature must be an object');
    const icon = item['icon'];
    if (typeof icon !== 'string' || !FEATURE_ICONS.includes(icon as FeatureIcon)) {
      throw new ContentValidationError(where, `"icon" must be one of ${FEATURE_ICONS.join(', ')}`);
    }
    return {
      icon: icon as FeatureIcon,
      title: requireString(item, 'title', where),
      detail: requireString(item, 'detail', where),
    };
  });
}

/** Full Instagram caption: body, blank line, hashtags. */
/** A sentence that ends in two full stops (the writer's full stop plus one added when the closing line was joined on) ends in one; an ellipsis ("...") is left alone. */
export const tidyPunctuation = (text: string): string => text.replace(/(?<![.\u2026])\.{2}(?![.\u2026])/g, '.');

export function composeCaption(post: Pick<PlannedPost, 'caption' | 'hashtags'>): string {
  return `${tidyPunctuation(post.caption.trim())}\n\n${post.hashtags.join(' ')}`;
}

function parsePost(raw: unknown, source: string): PlannedPost {
  if (!isRecord(raw)) throw new ContentValidationError(source, 'post must be an object');
  const id = requireString(raw, 'id', source);
  const where = `${source}#${id}`;
  const mode = raw['mode'];
  if (mode !== 'template' && mode !== 'ai') {
    throw new ContentValidationError(where, '"mode" must be "template" or "ai"');
  }
  const date = requireString(raw, 'date', where);
  if (Number.isNaN(Date.parse(date)) || !/[+-]\d{2}:\d{2}$|Z$/.test(date)) {
    throw new ContentValidationError(where, '"date" must be ISO 8601 with a timezone offset');
  }
  const hashtags = raw['hashtags'];
  if (!Array.isArray(hashtags) || !hashtags.every((h) => typeof h === 'string' && /^#\S+$/.test(h))) {
    throw new ContentValidationError(where, '"hashtags" must be an array of #tags');
  }
  if (hashtags.length > INSTAGRAM_HASHTAG_LIMIT) {
    throw new ContentValidationError(where, `at most ${INSTAGRAM_HASHTAG_LIMIT} hashtags allowed`);
  }
  const post: PlannedPost = {
    id,
    date,
    painPoint: requireString(raw, 'painPoint', where),
    mode,
    headline: requireString(raw, 'headline', where),
    subline: raw['subline'] === '' ? '' : requireString(raw, 'subline', where),
    caption: requireString(raw, 'caption', where),
    hashtags,
  };
  if (raw['variants'] !== undefined) {
    const variants = raw['variants'];
    if (!isObject(variants)) throw new ContentValidationError(where, '"variants" must be an object keyed by network');
    const parsed: PostVariants = {};
    for (const [network, value] of Object.entries(variants)) {
      if (!isNetwork(network)) throw new ContentValidationError(where, `"variants.${network}" is not a network`);
      if (!isObject(value) || typeof value['caption'] !== 'string' || !value['caption'].trim() || value['caption'].length > 2200) throw new ContentValidationError(where, `"variants.${network}.caption" must be text of at most 2200 characters`);
      const tags = value['hashtags'];
      if (!Array.isArray(tags) || !tags.every((h) => typeof h === 'string' && /^#\S+$/.test(h)) || tags.length > INSTAGRAM_HASHTAG_LIMIT) throw new ContentValidationError(where, `"variants.${network}.hashtags" must be an array of #tags`);
      parsed[network] = { caption: value['caption'].trim(), hashtags: tags as string[], ...(value['fallback'] === true ? { fallback: true } : {}) };
    }
    if (Object.keys(parsed).length > 0) post.variants = parsed;
  }
  if (mode === 'ai') post.imagePrompt = requireString(raw, 'imagePrompt', where);
  if (raw['layout'] !== undefined) {
    if (!isLayoutName(raw['layout'])) throw new ContentValidationError(where, `"layout" must be one of ${LAYOUTS.join(', ')}`);
    post.layout = raw['layout'];
  }
  if (raw['format'] !== undefined) {
    if (!isFormatName(raw['format'])) throw new ContentValidationError(where, `"format" must be one of ${FORMATS.join(', ')}`);
    post.format = raw['format'];
  }
  if (raw['pillar'] !== undefined) {
    if (typeof raw['pillar'] !== 'string' || !raw['pillar'].trim()) throw new ContentValidationError(where, '"pillar" must be text');
    post.pillar = raw['pillar'].trim();
  }
  for (const key of ['hook', 'requestedHook'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) throw new ContentValidationError(where, `"${key}" must be text`);
    post[key] = value.trim();
  }
  for (const key of ['anchor', 'revisitOf'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) throw new ContentValidationError(where, `"${key}" must be text`);
    post[key] = value.trim();
  }
  if (raw['cta'] !== undefined) post.cta = parseCta(raw['cta'], `${where}`);
  if (raw['ctaReason'] !== undefined) {
    if (typeof raw['ctaReason'] !== 'string' || !raw['ctaReason'].trim()) throw new ContentValidationError(where, '"ctaReason" must be text');
    post.ctaReason = raw['ctaReason'].trim();
  }
  if (raw['art'] !== undefined) post.art = parseArt(raw['art'], where);
  if (raw['artFailure'] !== undefined) {
    const failure = raw['artFailure'];
    if (!isObject(failure) || !Array.isArray(failure['reasons']) || !failure['reasons'].every((r) => typeof r === 'string')) throw new ContentValidationError(where, '"artFailure.reasons" must be a list of text');
    post.artFailure = { reasons: failure['reasons'] as string[] };
  }
  if (raw['approval'] !== undefined) {
    const approval = raw['approval'];
    if (!isObject(approval) || !['pending', 'approved', 'rejected'].includes(String(approval['status']))) throw new ContentValidationError(where, '"approval.status" must be pending, approved or rejected');
    const parsed: PostApproval = { status: approval['status'] as PostApproval['status'] };
    for (const key of ['at', 'by', 'reason'] as const) {
      const value = approval[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value.trim()) throw new ContentValidationError(where, `"approval.${key}" must be text`);
      parsed[key] = value.trim();
    }
    post.approval = parsed;
  }
  if (raw['concept'] !== undefined) {
    try {
      post.concept = parseConcept(raw['concept']);
    } catch (error) {
      throw new ContentValidationError(where, error instanceof Error ? error.message : String(error));
    }
  }
  for (const key of ['hookWarnings', 'listItems', 'factIds', 'evidenceChecks'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new ContentValidationError(where, `"${key}" must be a list of text`);
    post[key] = value as string[];
  }
  if (composeCaption(post).length > INSTAGRAM_CAPTION_LIMIT) {
    throw new ContentValidationError(where, `caption exceeds ${INSTAGRAM_CAPTION_LIMIT} characters`);
  }
  return post;
}

export function parseWeekPlan(raw: unknown, source: string): WeekPlan {
  if (!isRecord(raw)) throw new ContentValidationError(source, 'plan must be an object');
  const posts = raw['posts'];
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new ContentValidationError(source, '"posts" must be a non-empty array');
  }
  const parsed = posts.map((p) => parsePost(p, source));
  const ids = new Set(parsed.map((p) => p.id));
  if (ids.size !== parsed.length) throw new ContentValidationError(source, 'post ids must be unique');
  const mode = raw['renderMode'];
  if (mode !== undefined && mode !== 'legacy' && mode !== 'art_v1' && mode !== 'ai_v1') throw new ContentValidationError(source, '"renderMode" must be legacy, art_v1 or ai_v1');
  return {
    brand: requireString(raw, 'brand', source),
    timezone: requireString(raw, 'timezone', source),
    ...(mode ? { renderMode: mode } : {}),
    posts: parsed,
  };
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export interface HeadlineSegment {
  text: string;
  accent: boolean;
}

/** Splits "Plain |accent| plain" into styled segments. */
export function parseHeadline(headline: string): HeadlineSegment[] {
  return headline
    .split('|')
    .map((text, index) => ({ text, accent: index % 2 === 1 }))
    .filter((segment) => segment.text.length > 0);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseArt(raw: unknown, where: string): PostArt {
  if (!isObject(raw)) throw new ContentValidationError(where, '"art" must be an object');
  const resolution = raw['resolution'];
  if (resolution !== 'directed' && resolution !== 'repaired' && resolution !== 'fallback') throw new ContentValidationError(where, '"art.resolution" must be directed, repaired or fallback');
  const list = raw['candidates'];
  if (!Array.isArray(list) || list.length === 0 || list.length > 8) throw new ContentValidationError(where, '"art.candidates" must hold 1 to 8 candidates');
  const candidates = list.map((entry, i): PostArtCandidate => {
    const at = `${where} art candidate ${i + 1}`;
    if (!isObject(entry) || typeof entry['optionId'] !== 'string' || !entry['optionId'].trim()) throw new ContentValidationError(at, '"optionId" must be text');
    let brief: ArtBrief;
    try {
      brief = parseArtBrief(entry['brief'], at);
    } catch (error) {
      throw new ContentValidationError(at, error instanceof ArtDirectionError ? error.message.replace(`${at}: `, '') : String(error));
    }
    const record = entry['record'];
    if (!isObject(record) || typeof record['layout'] !== 'string' || !(HIERARCHIES as readonly string[]).includes(String(record['hierarchy'])) || !(TEXT_ZONES as readonly string[]).includes(String(record['textZone'])) || !(PICTURE_ROLES as readonly string[]).includes(String(record['pictureRole']))) {
      throw new ContentValidationError(at, '"record" must name layout, hierarchy, textZone and pictureRole');
    }
    const imagePrompt = entry['imagePrompt'];
    if (imagePrompt !== undefined && (typeof imagePrompt !== 'string' || !imagePrompt.trim() || imagePrompt.length > 4000)) throw new ContentValidationError(at, '"imagePrompt" must be text of at most 4000 characters');
    if (brief.picture.role !== 'none' && imagePrompt === undefined) throw new ContentValidationError(at, 'a candidate with a picture needs its "imagePrompt"');
    return { optionId: entry['optionId'].trim(), brief, ...(typeof imagePrompt === 'string' ? { imagePrompt: imagePrompt.trim() } : {}), record: record as unknown as ArtRecord };
  });
  const art: PostArt = { resolution, candidates };
  for (const key of ['figure', 'quote'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) throw new ContentValidationError(where, `"art.${key}" must be text`);
    art[key] = value.trim();
  }
  if (raw['offer'] !== undefined) art.offer = parseOffer(raw['offer'], where);
  return art;
}

const OFFER_KINDS = ['price', 'trial', 'free', 'no_card', 'other'];
const OFFER_ICONS = ['tag', 'calendar', 'badge', 'card-slash'];

function parseOffer(raw: unknown, where: string): PostOffer {
  if (!isObject(raw)) throw new ContentValidationError(where, '"art.offer" must be an object');
  for (const key of ['factId', 'text', 'capturedAt'] as const) if (typeof raw[key] !== 'string' || !String(raw[key]).trim()) throw new ContentValidationError(where, `"art.offer.${key}" must be text`);
  if (!OFFER_KINDS.includes(String(raw['kind']))) throw new ContentValidationError(where, '"art.offer.kind" must be price, trial, free, no_card or other');
  for (const key of ['kicker', 'qualifier'] as const) if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !String(raw[key]).trim())) throw new ContentValidationError(where, `"art.offer.${key}" must be text`);
  if (raw['icon'] !== undefined && !OFFER_ICONS.includes(String(raw['icon']))) throw new ContentValidationError(where, '"art.offer.icon" is not a known icon');
  return { factId: String(raw['factId']), text: String(raw['text']).trim(), kind: raw['kind'] as PostOffer['kind'], capturedAt: String(raw['capturedAt']), ...(raw['kicker'] ? { kicker: String(raw['kicker']) } : {}), ...(raw['qualifier'] ? { qualifier: String(raw['qualifier']) } : {}), ...(raw['icon'] ? { icon: raw['icon'] as NonNullable<PostOffer['icon']> } : {}) };
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
