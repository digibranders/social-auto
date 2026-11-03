/**
 * The one-line brand identity: what the business is, in plain words, taken from its own site. It is never written from nothing: a line is
 * kept only when a quote on a page that was read supports it (see claims.ts), and the sources are tried in a fixed order: an approved line,
 * the homepage, an about page, an offering page, the page metadata. With nothing verified, the identity is the brand name alone, so no
 * category, audience or capability is ever invented.
 */
import { verifyClaim, type ClaimConfig, type PageSource, type VerifiedClaim } from './claims.ts';

export type IdentityKind = 'approved' | 'homepage' | 'about' | 'offering' | 'metadata' | 'name-only';

export interface IdentityCandidate {
  line: string;
  sourceUrl: string;
  quote: string;
}

export interface BrandIdentity {
  line: string;
  kind: IdentityKind;
  /** The page and the exact words the line rests on; null for an approved line and for the name alone. */
  source: { url: string; verbatimQuote: string; fetchedAt: string | null; contentHash: string | null } | null;
  verification: { status: 'verified' | 'approved' | 'unverified'; reasons: string[] };
}

export interface IdentityOptions {
  /** Words in a page address that mean it is the business's own account of itself. */
  aboutWords?: readonly string[];
  /** A line that is longer is a slogan, not a description. */
  maxChars?: number;
  claims?: Partial<ClaimConfig>;
}

const DEFAULT_ABOUT_WORDS = ['about', 'about-us', 'who-we-are', 'our-story', 'story', 'company', 'mission'];
const DEFAULT_MAX_CHARS = 90;
const RANK: Readonly<Record<IdentityKind, number>> = { approved: 0, homepage: 1, about: 2, offering: 3, metadata: 4, 'name-only': 5 };

/** The page title and description as a source of their own, addressed `metadata:<origin>`, so they are never confused with the homepage text. */
export function metadataSource(origin: string, parts: { title?: string; description?: string }, fetchedAt?: string): PageSource {
  return { url: `metadata:${origin}`, text: [parts.title, parts.description].filter(Boolean).join('. '), ...(fetchedAt ? { fetchedAt } : {}) };
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
  if (path === '') return 'homepage';
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
    return { line: input.approved.trim(), kind: 'approved', source: null, verification: { status: 'approved', reasons: ['a line approved by the client or the team, not read from the site'] } };
  }
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const sources = [...input.pages, ...input.metadata];
  const reasons: string[] = [];
  const verified: Array<{ claim: VerifiedClaim; kind: IdentityKind; line: string }> = [];
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
    const claim = verifyClaim({ text: line, sourceUrl: candidate.sourceUrl, quote: candidate.quote }, sources, { now: input.now, ...(options.claims ? { config: options.claims } : {}) });
    if (claim.verification.status !== 'verified') {
      reasons.push(`"${line.slice(0, 40)}": ${claim.verification.reasons.join('; ') || claim.verification.status}`);
      continue;
    }
    verified.push({ claim, kind: identityKindFor(candidate.sourceUrl, input.origin, options), line });
  }
  const best = [...verified].sort((a, b) => RANK[a.kind] - RANK[b.kind])[0];
  if (!best) {
    return { line: input.name.trim(), kind: 'name-only', source: null, verification: { status: 'unverified', reasons: ['no verified identity line on the site; the brand name alone is used', ...reasons] } };
  }
  const { source } = best.claim;
  return { line: best.line, kind: best.kind, source: { url: source.url, verbatimQuote: source.verbatimQuote, fetchedAt: source.fetchedAt, contentHash: source.contentHash }, verification: { status: 'verified', reasons: best.claim.verification.reasons } };
}
