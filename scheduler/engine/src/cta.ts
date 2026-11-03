/**
 * The call to action on a poster: an action the business's own site really offers, found among the links of its homepage. With no
 * recognisable action it falls back to visiting the site's real address, so a poster never invites people to do something the site cannot do
 * (no "book" button on a site that cannot take bookings). The rules are settings, in the language of the site.
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
}

/** In order of priority: the more specific the action, the earlier it stands. */
export const defaultCtaRules: readonly CtaRule[] = [
  { label: 'Book an appointment', words: ['book', 'booking', 'bookings', 'appointment', 'appointments', 'reserve', 'reservation', 'reservations', 'schedule'] },
  { label: 'Book a demo', words: ['demo'] },
  { label: 'Get a quote', words: ['quote', 'estimate'] },
  { label: 'See pricing', words: ['pricing', 'plans', 'price', 'prices'] },
  { label: 'Browse the shop', words: ['shop', 'store', 'products', 'catalog', 'catalogue'] },
  { label: 'See the menu', words: ['menu'] },
  { label: 'Explore our services', words: ['services', 'solutions'] },
  { label: 'Get started', words: ['signup', 'register', 'sign up', 'get started', 'trial', 'free trial'] },
  { label: 'Donate', words: ['donate', 'donation'] },
  { label: 'Get in touch', words: ['contact'] },
  { label: 'Read the blog', words: ['blog', 'articles', 'resources', 'journal'] },
];

export interface CallToAction {
  kind: 'site-action' | 'visit-site';
  label: string;
  /** The link that shows the site offers this action; null for the fallback. */
  evidence: { linkText: string; url: string; region: LinkRegion } | null;
  /** The line used in captions and on the poster. */
  text: string;
}

const REGION_ORDER: Readonly<Record<LinkRegion, number>> = { nav: 0, body: 1, footer: 2 };
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

export function chooseCallToAction(links: readonly CtaLink[], origin: string, host: string, rules: readonly CtaRule[] = defaultCtaRules): CallToAction {
  const internal = links.filter((l) => sameSite(l.url, origin));
  for (const rule of rules) {
    const matches = internal.filter((l) => {
      let path = '';
      try {
        path = new URL(l.url).pathname;
      } catch {
        // an unreadable address cannot be evidence
      }
      const words = [...wordsOf(l.text), ...wordsOf(path)];
      return rule.words.some((w) => hasPhrase(words, w));
    });
    const best = [...matches].sort((a, b) => REGION_ORDER[a.region] - REGION_ORDER[b.region])[0];
    if (best) return { kind: 'site-action', label: rule.label, evidence: { linkText: best.text, url: best.url, region: best.region }, text: `${rule.label} at ${host} (link in bio)` };
  }
  return { kind: 'visit-site', label: 'Visit the website', evidence: null, text: `Visit ${host} (link in bio)` };
}
