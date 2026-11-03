import { readFile } from 'node:fs/promises';

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
}

function requireStringArray(obj: Record<string, unknown>, key: string, source: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === 'string' && v.trim())) {
    throw new ContentValidationError(source, `"${key}" must be a non-empty array of strings`);
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
    name: requireString(raw, 'name', source),
    website: requireString(raw, 'website', source),
    handleUrl: requireString(raw, 'handleUrl', source),
    offer: requireString(raw, 'offer', source),
    audience: requireString(raw, 'audience', source),
    tone: requireString(raw, 'tone', source),
    proofPoints: requireStringArray(raw, 'proofPoints', source),
    callToAction: requireString(raw, 'callToAction', source),
    rules: requireStringArray(raw, 'rules', source),
    colors: parsedColors,
    font: requireString(raw, 'font', source),
    logo: requireString(raw, 'logo', source),
    mark: requireString(raw, 'mark', source),
    features: parseFeatures(raw['features'], source),
  };
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
