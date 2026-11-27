/**
 * The call to action on a poster: an action the business's own site really offers, found among the links of its homepage. Every link that
 * could mean an action is scored, not just matched: where it sits (the main navigation over the body over the footer), whether its visible
 * text says it or only its address, how short it is (an article title is not a button), and, last, the rules' order, which settles ties.
 * With no credible action, or a site in a language the rules do not cover, it falls back to visiting the site's real address, so a poster
 * never invites people to do something the site cannot do. The rules and limits are settings.
 */
import type { LinkRegion } from './pages.ts';

export interface CtaLink {
  text: string;
  url: string;
  region: LinkRegion;
}

export interface CtaRule {
  /** What the poster says. */
  label: string;
  /** Words (or phrases) in a link's text or address that mean the site offers this action. */
  words: readonly string[];
  /** Words that, anywhere in the same link, mean it is something else ("floor plans" is not pricing). */
  unless?: readonly string[];
}

/** In order of priority, which only settles ties between links that are equally likely. */
export const defaultCtaRules: readonly CtaRule[] = [
  { label: 'Book an appointment', words: ['book', 'booking', 'bookings', 'appointment', 'appointments', 'reserve', 'reservation', 'reservations', 'schedule'] },
  { label: 'Book a demo', words: ['demo'] },
  { label: 'Get a quote', words: ['quote', 'estimate'] },
  { label: 'See pricing', words: ['pricing', 'plans', 'price', 'prices'], unless: ['floor', 'floorplan', 'seating', 'meal', 'meals'] },
  { label: 'Browse the shop', words: ['shop', 'store', 'products', 'catalog', 'catalogue'], unless: ['locator', 'location', 'locations', 'find', 'near', 'nearest'] },
  { label: 'See the menu', words: ['menu'] },
  { label: 'Explore our services', words: ['services', 'solutions'] },
  { label: 'Get started', words: ['signup', 'register', 'sign up', 'get started', 'trial', 'free trial'] },
  { label: 'Donate', words: ['donate', 'donation'] },
  { label: 'Get in touch', words: ['contact'] },
  { label: 'Read the blog', words: ['blog', 'articles', 'resources', 'journal'] },
];

export interface CtaOptions {
  /** The site's language (`<html lang>`). A language the rules do not cover gives the safe fallback. */
  language?: string | null;
  /** The language the rules are written in. */
  rulesLanguage?: string;
  /** A link with more words than this is a sentence or an article title, not an action. */
  maxWords?: number;
  /** An address with more segments than this is deep content, not a main page. */
  maxPathSegments?: number;
}

export interface CallToAction {
  kind: 'site-action' | 'visit-site';
  label: string;
  /** The link that shows the site offers this action; null for the fallback. */
  evidence: { linkText: string; url: string; region: LinkRegion } | null;
  /** The line used in captions and on the poster. */
  text: string;
}

const REGION_SCORE: Readonly<Record<LinkRegion, number>> = { nav: 5, body: 2, footer: 0 };
const TEXT_MATCH = 3;
const PATH_MATCH = 1.5;
const RULE_ORDER_WEIGHT = 2;
const LONG_TEXT_PENALTY = 0.5;
const SHORT_TEXT_WORDS = 3;

const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const withoutWww = (origin: string): string => origin.replace(/^(https?:\/\/)www\./, '$1');

function sameSite(url: string, origin: string): boolean {
  try {
    return withoutWww(new URL(url).origin) === withoutWww(new URL(origin).origin);
  } catch {
    return false;
  }
}

/** True when the phrase stands in the words as a run, so "plans" is not found inside "airplanes". */
function hasPhrase(words: readonly string[], phrase: string): boolean {
  const target = wordsOf(phrase);
  return target.length > 0 && words.some((_, i) => target.every((w, j) => words[i + j] === w));
}

export function chooseCallToAction(links: readonly CtaLink[], origin: string, host: string, rules: readonly CtaRule[] = defaultCtaRules, options: CtaOptions = {}): CallToAction {
  const fallback: CallToAction = { kind: 'visit-site', label: 'Visit the website', evidence: null, text: `Visit ${host}` };
  const language = options.language?.toLowerCase().split('-')[0];
  if (language && language !== (options.rulesLanguage ?? 'en').toLowerCase().split('-')[0]) return fallback;
  const maxWords = options.maxWords ?? 5;
  const maxSegments = options.maxPathSegments ?? 3;
  const last = Math.max(1, rules.length - 1);

  let best: { score: number; ruleIndex: number; link: CtaLink; rule: CtaRule } | undefined;
  for (const link of links) {
    if (!sameSite(link.url, origin)) continue;
    let path = '';
    try {
      path = new URL(link.url).pathname;
    } catch {
      continue;
    }
    const textWords = wordsOf(link.text);
    if (textWords.length > maxWords || path.split('/').filter(Boolean).length > maxSegments) continue;
    const pathWords = wordsOf(path);
    const all = [...textWords, ...pathWords];
    for (const [ruleIndex, rule] of rules.entries()) {
      if (rule.unless?.some((u) => hasPhrase(all, u))) continue;
      const inText = rule.words.some((w) => hasPhrase(textWords, w));
      if (!inText && !rule.words.some((w) => hasPhrase(pathWords, w))) continue;
      const score = REGION_SCORE[link.region] + (inText ? TEXT_MATCH : PATH_MATCH) + (RULE_ORDER_WEIGHT * (last - ruleIndex)) / last - Math.max(0, textWords.length - SHORT_TEXT_WORDS) * LONG_TEXT_PENALTY;
      if (!best || score > best.score || (score === best.score && ruleIndex < best.ruleIndex)) best = { score, ruleIndex, link, rule };
    }
  }
  if (!best) return fallback;
  return { kind: 'site-action', label: best.rule.label, evidence: { linkText: best.link.text, url: best.link.url, region: best.link.region }, text: `${best.rule.label} at ${host}` };
}

/** The neutral call to action: visit the site. Used when the chosen one does not fit what a post is about. */
export function neutralCta(host: string): CallToAction {
  return { kind: 'visit-site', label: 'Visit the website', evidence: null, text: `Visit ${host}` };
}
