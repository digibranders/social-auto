import { readFile } from 'node:fs/promises';
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
  caption: string;
  hashtags: string[];
}

export interface WeekPlan {
  brand: string;
  timezone: string;
  posts: PlannedPost[];
}

export class ContentValidationError extends Error {
  constructor(source: string, problem: string) {
    super(`${source}: ${problem}`);
    this.name = 'ContentValidationError';
  }
}

const INSTAGRAM_CAPTION_LIMIT = 2200;
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
  };
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
  return { line, kind: kind as BrandIdentity['kind'], source: sourceRecord, verification: { status: verification['status'] as BrandIdentity['verification']['status'], reasons: verification['reasons'] as string[] } };
}

function parseCta(raw: unknown, source: string): CallToAction {
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
export function composeCaption(post: Pick<PlannedPost, 'caption' | 'hashtags'>): string {
  return `${post.caption.trim()}\n\n${post.hashtags.join(' ')}`;
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
    subline: requireString(raw, 'subline', where),
    caption: requireString(raw, 'caption', where),
    hashtags,
  };
  if (mode === 'ai') post.imagePrompt = requireString(raw, 'imagePrompt', where);
  if (raw['layout'] !== undefined) {
    if (!isLayoutName(raw['layout'])) throw new ContentValidationError(where, `"layout" must be one of ${LAYOUTS.join(', ')}`);
    post.layout = raw['layout'];
  }
  if (raw['format'] !== undefined) {
    if (!isFormatName(raw['format'])) throw new ContentValidationError(where, `"format" must be one of ${FORMATS.join(', ')}`);
    post.format = raw['format'];
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
  return {
    brand: requireString(raw, 'brand', source),
    timezone: requireString(raw, 'timezone', source),
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

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
