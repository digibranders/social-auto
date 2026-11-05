/**
 * The one-line brand identity: what the business is, in plain words, taken from its own site. It is never written from nothing: a line is
 * kept only when a quote on a page that was read supports it (see claims.ts) and it reads as a description, not a slogan. Candidates are ranked
 * by what they say first (how descriptive and specific, how well the quote supports it) and by where they come from second: an approved line,
 * the homepage, an about page, an offering page, the page title or description. With nothing verified, the identity is the brand name alone,
 * so no category, audience or capability is ever invented.
 */
import { verifyClaim, type ClaimConfig, type PageSource, type VerifiedClaim } from './claims.ts';

export type IdentityKind = 'approved' | 'homepage' | 'about' | 'offering' | 'metadata' | 'name-only';

export interface IdentityCandidate {
  line: string;
  sourceUrl: string;
  quote: string;
}

export type IdentityType = 'descriptive' | 'uncertain';

export interface BrandIdentity {
  line: string;
  kind: IdentityKind;
  /** Whether the line plainly says what the business is, or only might; null for an approved line and for the name alone. */
  type: IdentityType | null;
  /** The page and the exact words the line rests on; null for an approved line and for the name alone. */
  source: { url: string; verbatimQuote: string; fetchedAt: string | null; contentHash: string | null } | null;
  verification: { status: 'verified' | 'approved' | 'unverified'; reasons: string[] };
}

export interface IdentityOptions {
  /** Words in a page address that mean it is the business's own account of itself. */
  aboutWords?: readonly string[];
  /** A line that is longer is a slogan, not a description. */
  maxChars?: number;
  /** Words that open a command or a motto ("think", "discover", "join"): a line that starts with one is a slogan. */
  imperativeWords?: readonly string[];
  /** Words that join a thing to its purpose or audience ("for", "that", "who"): a description has one. */
  connectorWords?: readonly string[];
  /** Language codes that may stand as the first path segment of a homepage ("/en/", "/hi"). */
  localeRoots?: readonly string[];
  claims?: Partial<ClaimConfig>;
}

const DEFAULT_ABOUT_WORDS = ['about', 'about-us', 'who-we-are', 'our-story', 'story', 'company', 'mission'];
const DEFAULT_MAX_CHARS = 90;
const DEFAULT_IMPERATIVES = ['think', 'imagine', 'discover', 'join', 'experience', 'welcome', 'dream', 'make', 'live', 'get', 'start', 'be', 'choose', 'find', 'just', 'let', 'love', 'believe', 'create', 'unlock', 'elevate', 'transform', 'empower', 'reimagine', 'explore', 'build', 'try', 'see', 'feel'];
const DEFAULT_CONNECTORS = ['for', 'that', 'which', 'who', 'to', 'with', 'by'];
const DEFAULT_LOCALE_ROOTS = ['en', 'hi', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'ja', 'ko', 'zh', 'ar', 'tr', 'pl', 'sv', 'da', 'no', 'fi', 'cs', 'el', 'he', 'id', 'th', 'vi', 'uk', 'ro', 'hu', 'bn', 'ta', 'te', 'mr', 'gu', 'ur'];
/** How much a source is trusted to describe the business; secondary to what the line says. */
const SOURCE_WEIGHT: Readonly<Record<IdentityKind, number>> = { approved: 3, homepage: 1.5, about: 1.2, 'name-only': 0, metadata: 0.5, offering: 1 };
const TYPE_WEIGHT: Readonly<Record<IdentityType, number>> = { descriptive: 3, uncertain: 1 };

/**
 * The title and the description of each page as sources of their own, addressed `metadata:title:<page>` and `metadata:description:<page>`,
 * so a quote can never span two texts that were not written together, nor be confused with the page body.
 */
export function metadataSources(pages: ReadonlyArray<{ url: string; title?: string; description?: string; fetchedAt?: string }>): PageSource[] {
  return pages.flatMap((page) =>
    (['title', 'description'] as const)
      .filter((field) => page[field]?.trim())
      .map((field) => ({ url: `metadata:${field}:${page.url}`, text: (page[field] as string).trim(), ...(page.fetchedAt ? { fetchedAt: page.fetchedAt } : {}) })),
  );
}

const wordsOfLine = (line: string): string[] => line.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);

/**
 * Whether a line reads as a description of the business. A command or motto is a slogan; a line that joins a thing to its purpose or
 * audience ("software for small businesses") is descriptive; anything else might be, and is used only when nothing better exists. It
 * reads sentence structure, never industry words, and it is a filter, not a proof: the quote check still decides whether the site says it.
 */
export function classifyIdentity(line: string, options: IdentityOptions = {}): 'slogan' | IdentityType {
  const words = wordsOfLine(line);
  const imperatives = new Set((options.imperativeWords ?? DEFAULT_IMPERATIVES).map((w) => w.toLowerCase()));
  const connectors = new Set((options.connectorWords ?? DEFAULT_CONNECTORS).map((w) => w.toLowerCase()));
  const hasConnector = words.some((w) => connectors.has(w));
  if (words.length === 0 || imperatives.has(words[0] as string) || (words.length <= 3 && !hasConnector)) return 'slogan';
  return words.length >= 4 && hasConnector ? 'descriptive' : 'uncertain';
}

/** Where a page stands on the ladder, judged by its address. */
export function identityKindFor(url: string, origin: string, options: IdentityOptions = {}): Exclude<IdentityKind, 'approved' | 'name-only'> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'offering';
  }
  if (parsed.protocol === 'metadata:') return 'metadata';
  const path = parsed.pathname.replace(/\/+$/, '');
  const roots = new Set((options.localeRoots ?? DEFAULT_LOCALE_ROOTS).map((r) => r.toLowerCase()));
  const first = path.split('/').filter(Boolean);
  if (path === '' || (first.length === 1 && roots.has((first[0] as string).toLowerCase().split('-')[0] as string) && /^[a-z]{2}(-[a-z]{2,4})?$/i.test(first[0] as string))) return 'homepage';
  const words = (options.aboutWords ?? DEFAULT_ABOUT_WORDS).map((w) => w.toLowerCase());
  const segments = path.toLowerCase().split('/').filter(Boolean);
  if (segments.some((s) => words.includes(s))) return 'about';
  void origin;
  return 'offering';
}

const isOneSentence = (line: string): boolean => !/[.!?]\s+\S/.test(line.trim());

export function chooseIdentity(input: {
  name: string;
  origin: string;
  candidates: readonly IdentityCandidate[];
  pages: readonly PageSource[];
  /** The page title and description, from `metadataSource`. */
  metadata: readonly PageSource[];
  now: Date;
  approved?: string;
  options?: IdentityOptions;
}): BrandIdentity {
  const options = input.options ?? {};
  if (input.approved?.trim()) {
    return { line: input.approved.trim(), kind: 'approved', type: null, source: null, verification: { status: 'approved', reasons: ['a line approved by the client or the team, not read from the site'] } };
  }
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const sources = [...input.pages, ...input.metadata];
  const reasons: string[] = [];
  const verified: Array<{ claim: VerifiedClaim; kind: IdentityKind; line: string; type: IdentityType; score: number }> = [];
  for (const candidate of input.candidates) {
    const line = candidate.line.trim();
    if (!line || line.length > maxChars) {
      reasons.push(`"${line.slice(0, 40)}": longer than ${maxChars} characters, so it is a slogan, not a description`);
      continue;
    }
    if (!isOneSentence(line)) {
      reasons.push(`"${line.slice(0, 40)}": more than one sentence`);
      continue;
    }
    const type = classifyIdentity(line, options);
    if (type === 'slogan') {
      reasons.push(`"${line.slice(0, 40)}": reads as a slogan, not a description of what the business is`);
      continue;
    }
    const claim = verifyClaim({ text: line, sourceUrl: candidate.sourceUrl, quote: candidate.quote }, sources, { now: input.now, ...(options.claims ? { config: options.claims } : {}) });
    if (claim.verification.status !== 'verified') {
      reasons.push(`"${line.slice(0, 40)}": ${claim.verification.reasons.join('; ') || claim.verification.status}`);
      continue;
    }
    const kind = identityKindFor(candidate.sourceUrl, input.origin, options);
    // What the line says counts first; where it was found only settles close calls.
    const specificity = Math.min(2, Math.max(0, (wordsOfLine(line).length - 3) / 3));
    verified.push({ claim, kind, line, type, score: TYPE_WEIGHT[type] + specificity + claim.verification.confidence * 2 + SOURCE_WEIGHT[kind] });
  }
  const best = [...verified].sort((a, b) => b.score - a.score)[0];
  if (!best) {
    return { line: input.name.trim(), kind: 'name-only', type: null, source: null, verification: { status: 'unverified', reasons: ['no verified identity line on the site; the brand name alone is used', ...reasons] } };
  }
  const { source } = best.claim;
  return { line: best.line, kind: best.kind, type: best.type, source: { url: source.url, verbatimQuote: source.verbatimQuote, fetchedAt: source.fetchedAt, contentHash: source.contentHash }, verification: { status: 'verified', reasons: best.claim.verification.reasons } };
}
