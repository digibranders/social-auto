/**
 * The offer a poster may show large: one usable commercial fact of the post, in its own words. Nothing is rephrased and nothing is combined:
 * the fact's text is the offer, the plan it belongs to (when the page gave one) is the kicker, and a tax or condition note appears under it
 * only when it was confirmed for the same plan. The icon comes from a fixed map of what the fact states (never from keywords in the copy), and
 * is left out when the fact is ambiguous: a crossed card appears only for an explicit "no credit card".
 */
import { normalizeForQuote } from './claims.ts';
import type { EvidenceFact } from './evidence.ts';
import { offerableFacts } from './fact-assignment.ts';

export type OfferKind = 'price' | 'trial' | 'free' | 'no_card' | 'other';
export type OfferIcon = 'tag' | 'calendar' | 'badge' | 'card-slash';

export interface PostOffer {
  factId: string;
  /** The fact's own words. */
  text: string;
  /** The plan or card the fact belongs to, when the page said so. */
  kicker?: string;
  /** A condition confirmed for the same plan (a tax note), shown under the offer. */
  qualifier?: string;
  kind: OfferKind;
  icon?: OfferIcon;
  /** When the fact was read; the renderer holds an offer that has grown stale. */
  capturedAt: string;
}

/** The longest fact that reads well as a large statement. */
export const MAX_OFFER_CHARS = 60;

const has = (text: string, pattern: RegExp): boolean => pattern.test(normalizeForQuote(text));
const NO_CARD = /(?<![\p{L}\p{N}])no credit[- ]card(?![\p{L}])/u;
const TRIAL = /(?<![\p{L}\p{N}])trials?(?![\p{L}])/u;
const FREE = /(?<![\p{L}\p{N}])free (?:forever|plan|tier)(?![\p{L}])/u;
const TAX = /(?<![\p{L}\p{N}])(?:gst|vat|tax|taxes)(?![\p{L}])/u;

export function offerKind(fact: Pick<EvidenceFact, 'text' | 'values'>): OfferKind {
  if (has(fact.text, NO_CARD)) return 'no_card';
  if (fact.values.prices.length > 0) return 'price';
  if (has(fact.text, TRIAL)) return 'trial';
  if (has(fact.text, FREE)) return 'free';
  return 'other';
}

const ICONS: Readonly<Record<OfferKind, OfferIcon | undefined>> = { price: 'tag', trial: 'calendar', free: 'badge', no_card: 'card-slash', other: undefined };

/** The offer of a post from the facts assigned to it, or undefined when none qualifies. Only usable, current, brand-owned commercial facts of a display-friendly length. */
export function offerFrom(factIds: readonly string[] | undefined, facts: readonly EvidenceFact[]): PostOffer | undefined {
  if (!factIds || factIds.length === 0) return undefined;
  const mine = factIds.flatMap((id) => facts.find((f) => f.id === id) ?? []);
  const candidates = offerableFacts(mine).filter((f) => f.category === 'commercial_term' && f.text.length <= MAX_OFFER_CHARS && !has(f.text, TAX));
  const fact = candidates[0];
  if (!fact) return undefined;
  const kind = offerKind(fact);
  // A condition counts only if the page tied it to the same plan or card as the offer.
  const note = fact.scope === undefined ? undefined : offerableFacts(facts).find((f) => f.id !== fact.id && f.source.url === fact.source.url && f.scope === fact.scope && has(f.text, TAX) && f.text.length <= 90);
  return {
    factId: fact.id,
    text: fact.text,
    ...(fact.scope !== undefined ? { kicker: fact.scope } : {}),
    ...(note ? { qualifier: note.text } : {}),
    kind,
    ...(ICONS[kind] ? { icon: ICONS[kind] as OfferIcon } : {}),
    capturedAt: fact.capturedAt,
  };
}

/** Plain inline SVGs, drawn in the text colour; decorative only (the offer's words carry the meaning). */
export const ICON_SVG: Readonly<Record<OfferIcon, string>> = {
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="8" cy="8" r="1.6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  badge: '<circle cx="12" cy="10" r="6"/><path d="M8.5 15.5 7 22l5-3 5 3-1.5-6.5"/>',
  'card-slash': '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M4 21 20 3"/>',
};

export function iconHtml(icon: OfferIcon): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:0.72em;height:0.72em;vertical-align:-0.06em;margin-right:0.3em;flex:none">${ICON_SVG[icon]}</svg>`;
}
