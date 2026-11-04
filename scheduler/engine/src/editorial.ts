/**
 * Editorial checks on a post's copy, kept deliberately narrow. Only what code can judge without taste is a hard failure, sent back to the
 * writer with the reason: a subline that is the headline (or the identity line) said again, or says it in nearly the same words and adds no
 * supported information. Everything else is a warning for the reviewer. Whether a headline is strong is never scored. A subline with similar
 * vocabulary that adds a fact or a qualification is allowed ("Free plan. No credit card required." after "Start with a free plan").
 */
import { extractFacts, normalizeForQuote } from './claims.ts';
import type { EvidenceCategory } from './evidence.ts';

export interface EditorialCopy { headline: string; subline: string }
export interface CitedFact { text: string; category: EvidenceCategory }
export interface EditorialContext {
  brandName: string;
  identityLine?: string;
  /** The call to action as written, e.g. "See pricing at acme.example". */
  cta?: string;
  /** The facts the post was assigned; without them "adds supported information" can only be judged by new figures. */
  citedFacts?: readonly CitedFact[];
}

export type EditorialCode = 'subline_restates_headline' | 'subline_restates_identity' | 'subline_adds_nothing' | 'subline_overlap_unsupported_extra' | 'brand_name_repeated' | 'cta_mismatch';
export interface EditorialIssue { code: EditorialCode; message: string }
export interface EditorialResult { hard: EditorialIssue[]; warnings: EditorialIssue[] }

export interface EditorialConfig {
  stopWords: readonly string[];
  /** Similarity of content stems from which a subline "says it again". */
  nearIdentical: number;
  /** Similarity from which extra wording is worth a warning. */
  overlapWarning: number;
  pricingCtaWords: readonly string[];
}

export const defaultEditorialConfig: EditorialConfig = {
  stopWords: ['a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'your', 'you', 'our', 'we', 'is', 'are', 'was', 'be', 'to', 'of', 'in', 'on', 'at', 'by', 'it', 'its', 'this', 'that', 'from', 'as', 'can', 'will', 'all', 'one', 'more', 'has', 'have', 'who', 'what', 'how', 'why', 'not', 'no', 'so', 'if', 'do', 'does', 'into', 'out', 'up', 'than', 'then', 'them', 'they', 'their'],
  nearIdentical: 0.85,
  overlapWarning: 0.6,
  pricingCtaWords: ['pricing', 'price', 'prices', 'plans', 'plan', 'buy', 'subscribe', 'checkout'],
};

const words = (text: string): string[] => normalizeForQuote(text.replaceAll('|', '')).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const stem = (word: string): string => word.slice(0, 5);

function contentStems(text: string, drop: ReadonlySet<string>, config: EditorialConfig): Set<string> {
  const stop = new Set(config.stopWords);
  return new Set(words(text).filter((w) => !stop.has(w) && !drop.has(w) && (w.length >= 3 || /\d/.test(w))).map(stem));
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  const shared = [...a].filter((x) => b.has(x)).length;
  return shared / (a.size + b.size - shared);
};

const figuresOf = (text: string): Set<string> => {
  const f = extractFacts(text);
  return new Set([...f.numbers, ...f.prices, ...f.periods, ...f.qualifiers.map((q) => q.split('|')[0] ?? q)]);
};

export function validateEditorial(copy: EditorialCopy, context: EditorialContext, options: Partial<EditorialConfig> = {}): EditorialResult {
  const config = { ...defaultEditorialConfig, ...options };
  const hard: EditorialIssue[] = [];
  const warnings: EditorialIssue[] = [];
  const brand = new Set(words(context.brandName));
  const noBrand = (text: string): string => words(text).filter((w) => !brand.has(w)).join(' ');

  const headStems = contentStems(copy.headline, brand, config);
  const subStems = contentStems(copy.subline, brand, config);
  const identity = context.identityLine?.trim();

  if (noBrand(copy.subline) !== '' && noBrand(copy.subline) === noBrand(copy.headline)) {
    hard.push({ code: 'subline_restates_headline', message: 'the subline says the headline again; give it a different, supported point' });
  } else if (identity && noBrand(copy.subline) !== '' && noBrand(copy.subline) === noBrand(identity)) {
    hard.push({ code: 'subline_restates_identity', message: 'the subline repeats the identity line printed on the poster; give it a different, supported point' });
  } else if (subStems.size > 0 && headStems.size > 0) {
    const similarity = jaccard(headStems, subStems);
    const extra = [...subStems].filter((s) => !headStems.has(s));
    const headFigures = figuresOf(copy.headline);
    const newFigure = [...figuresOf(copy.subline)].some((f) => !headFigures.has(f));
    const citedStems = new Set((context.citedFacts ?? []).flatMap((f) => [...contentStems(f.text, brand, config)]));
    const supportedExtra = extra.filter((s) => citedStems.has(s));
    if (similarity >= config.nearIdentical && !newFigure && supportedExtra.length === 0) {
      hard.push({ code: 'subline_adds_nothing', message: 'the subline repeats the headline in nearly the same words and adds nothing supported; say something the headline does not' });
    } else if (similarity >= config.overlapWarning && !newFigure && supportedExtra.length === 0 && extra.length > 0) {
      warnings.push({ code: 'subline_overlap_unsupported_extra', message: 'the subline overlaps the headline and its extra wording is not backed by the post\'s facts' });
    }
  }

  const count = (text: string): number => { const t = words(text).join(' '); const b = words(context.brandName).join(' '); return b === '' ? 0 : t.split(b).length - 1; };
  const mentions = count(copy.headline) + count(copy.subline) + (identity ? count(identity) : 0);
  if (mentions > 1 && subStems.size === 0) warnings.push({ code: 'brand_name_repeated', message: 'the brand name appears more than once and the subline adds nothing else' });
  else if (mentions > 2) warnings.push({ code: 'brand_name_repeated', message: `the brand name appears ${mentions} times across the headline, subline and identity line` });

  const cited = context.citedFacts ?? [];
  if (context.cta && cited.length > 0) {
    const pricing = new RegExp(`(?<![\\p{L}\\p{N}])(?:${config.pricingCtaWords.join('|')})(?![\\p{L}])`, 'iu').test(context.cta);
    if (pricing && !cited.some((f) => f.category === 'commercial_term' || f.category === 'offer')) {
      warnings.push({ code: 'cta_mismatch', message: 'the call to action points to pricing, but the post is built on facts that are not about price or plan' });
    }
  }
  return { hard, warnings };
}
