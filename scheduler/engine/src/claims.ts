/**
 * Source-backed claims. A claim about a business (a proof point, later a line of a post) is only used if it can be traced to the site, in three
 * independent layers:
 *
 *   1. the source is real: the page was read and the exact quote is on it;
 *   2. the quote supports the claim: its numbers, units, currencies, billing periods and qualifiers match, and it does not negate the claim;
 *   3. the rules for that kind of claim hold: a superlative or a guarantee must be made by the source itself, a time-sensitive claim needs recent evidence.
 *
 * Everything is deterministic and every list of words is a setting, so nothing here belongs to an industry or a language. A quote that exists
 * proves only that the words are on the page; layers 2 and 3 are what decide whether it supports the claim. Confidence is worked out from the
 * checks that passed, never taken from what a model said about itself.
 */
import { createHash } from 'node:crypto';

export type ClaimType = 'numeric' | 'price' | 'superlative' | 'guarantee' | 'time_sensitive' | 'capability' | 'subjective';
export type ClaimStatus = 'verified' | 'uncertain' | 'rejected';

export interface ClaimConfig {
  /** Superlatives. Words joined with "|" mean the same thing ("number one|#1"). */
  superlatives: readonly string[];
  guarantees: readonly string[];
  /** Words that limit a number ("from", "up to", "more than"). Joined with "|" when equivalent. */
  qualifiers: readonly string[];
  /** Words that make a claim depend on when it was true. */
  timeSensitive: readonly string[];
  negations: readonly string[];
  /** Nouns after a number that make it a list size, not a fact ("3 ways"). */
  editorialNouns: readonly string[];
  /** Verbs that say what a business or product does. */
  capabilityVerbs: readonly string[];
  /** How old a page may be for a time-sensitive claim. */
  maxAgeDays: number;
  /** How many words before a number or keyword a negation counts. */
  negationWindow: number;
  /** The share of the claim's longer words that must also be in the quote, as the same word or one sharing its first five letters; below it the claim needs review. */
  minWordOverlap: number;
}

export const defaultClaimConfig: ClaimConfig = {
  superlatives: ['best', 'number one|number 1|#1|no. 1|no.1', 'leading', 'fastest', 'cheapest', 'lowest', 'highest', 'greatest', 'ultimate', 'unmatched', 'unbeatable', 'world-class|world class', 'premier', 'top-rated|top rated'],
  guarantees: ['guarantee|guaranteed|guarantees', 'money-back|money back', 'warranty', 'risk-free|risk free'],
  qualifiers: ['up to', 'from|starting at|starts at|start from|starts from', 'more than|over|above|exceeding', 'less than|under|below', 'at least|minimum of', 'about|around|approximately|roughly|nearly'],
  timeSensitive: ['now', 'today', 'currently', 'this year', 'this month', 'this week', 'limited time|limited-time', 'ends', 'until'],
  negations: ['not', 'no', 'never', 'without', 'cannot', "can't", "don't", "doesn't", "isn't", "aren't", "won't", "didn't", "wasn't"],
  editorialNouns: ['ways', 'steps', 'tips', 'reasons', 'signs', 'things', 'ideas', 'questions', 'mistakes', 'lessons', 'myths', 'rules', 'hacks', 'secrets'],
  capabilityVerbs: ['supports', 'support', 'offers', 'provides', 'includes', 'integrates', 'connects', 'delivers', 'ships', 'handles', 'replies', 'responds', 'works', 'builds', 'creates', 'manages', 'tracks', 'sends', 'helps', 'lets', 'allows', 'enables'],
  maxAgeDays: 30,
  negationWindow: 4,
  minWordOverlap: 0.6,
};

/** A page that was read: its address, its text, and when it was fetched. */
export interface PageSource {
  url: string;
  text: string;
  fetchedAt?: string;
}

/** A claim as proposed: the words, the page it comes from and the exact words copied from that page. */
export interface ClaimInput {
  text: string;
  sourceUrl: string;
  quote: string;
}

export interface VerifiedClaim {
  text: string;
  type: ClaimType;
  source: { url: string; verbatimQuote: string; fetchedAt: string | null; contentHash: string | null };
  extracted: { numbers: string[]; currencies: string[]; periods: string[]; qualifiers: string[] };
  verification: { quoteFound: boolean; status: ClaimStatus; confidence: number; reasons: string[] };
}

export interface VerifyOptions {
  now: Date;
  config?: Partial<ClaimConfig>;
}

const merge = (config?: Partial<ClaimConfig>): ClaimConfig => ({ ...defaultClaimConfig, ...config });

/** Text as it is compared: Unicode-folded, curly quotes and dashes made plain, white space collapsed, lower case. */
export function normalizeForQuote(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The alternatives of one entry ("number one|#1" gives both). */
const alternatives = (entry: string): string[] => entry.split('|').map((a) => normalizeForQuote(a));

/** A phrase as a whole-word pattern (words, not parts of words). */
function phrasePattern(phrase: string): RegExp {
  const body = escapeRegex(phrase);
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u');
}

/** The entries of a list that appear in the text (as the entry itself, whichever of its alternatives was used). */
export function present(list: readonly string[], text: string): string[] {
  const t = normalizeForQuote(text);
  return list.filter((entry) => alternatives(entry).some((a) => phrasePattern(a).test(t)));
}

const CURRENCY_SYMBOL: Readonly<Record<string, string>> = { usd: '$', eur: '€', gbp: '£', inr: '₹', jpy: '¥', cny: '¥', rs: '₹', 'rs.': '₹' };
const PERIOD_WORDS: Readonly<Record<string, string>> = {
  month: 'month', monthly: 'month', months: 'month', year: 'year', yearly: 'year', annual: 'year', annually: 'year', annum: 'year', years: 'year',
  week: 'week', weekly: 'week', weeks: 'week', day: 'day', daily: 'day', days: 'day', hour: 'hour', hourly: 'hour', hours: 'hour', quarter: 'quarter', quarterly: 'quarter', mo: 'month', yr: 'year',
};
const UNIT_STOP = new Set(['and', 'or', 'the', 'for', 'with', 'out', 'of', 'in', 'on', 'at', 'by', 'to', 'per', 'from', 'is', 'are', 'a', 'an', 'that', 'who', 'which', 'as', 'it', 'its', 'our', 'we', 'you', 'your', 'plus']);

interface Facts {
  numbers: string[];
  /** Currency and amount together, e.g. "$29". */
  prices: string[];
  currencies: string[];
  periods: string[];
  /** A number with the word after it, e.g. ["25", "integrations"]. */
  units: Array<[string, string]>;
  /** Qualifiers standing right before a number: the list entry that matched. */
  qualifiers: string[];
}

const NUMBER = /(?<![\p{L}\p{N}.])(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(\s?%)?/gu;
const CURRENCY = /(\$|€|£|₹|¥|\b(?:usd|eur|gbp|inr|jpy|cny|rs\.?)\b)\s*(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?|(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?\s*(\$|€|£|₹|¥|\b(?:usd|eur|gbp|inr)\b)/giu;

const symbolOf = (raw: string): string => CURRENCY_SYMBOL[raw.toLowerCase()] ?? raw;
const plain = (whole: string, fraction?: string): string => `${whole.replace(/,/g, '')}${fraction && /[1-9]/.test(fraction) ? `.${fraction.replace(/0+$/, '')}` : ''}`;
export const stem = (word: string): string => word.replace(/ies$/, 'y').replace(/(?:es|s)$/, '');

/** The numbers, prices, billing periods, units and qualifiers a text states, normalised so "12,500" and "12500" are the same. */
export function extractFacts(text: string, config: ClaimConfig = defaultClaimConfig): Facts {
  const t = normalizeForQuote(text);
  const numbers: string[] = [];
  const units: Array<[string, string]> = [];
  const qualifiers: string[] = [];
  const words = t.split(/\s+/);
  for (const match of t.matchAll(NUMBER)) {
    const value = `${plain(match[1] ?? '', match[2])}${match[3] ? '%' : ''}`;
    numbers.push(value);
    const after = t.slice((match.index ?? 0) + match[0].length).trimStart().match(/^([\p{L}][\p{L}'-]*)/u)?.[1];
    if (!match[3] && after && after.length >= 3 && !UNIT_STOP.has(after) && !PERIOD_WORDS[after] && !/^(?:k|m|bn)$/.test(after)) units.push([value, stem(after)]);
    const before = t.slice(0, match.index ?? 0).split(/\s+/).filter(Boolean).slice(-3).join(' ');
    for (const entry of config.qualifiers) {
      if (alternatives(entry).some((a) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(a)}\\s*[$€£₹¥]?\\s*$`, 'u').test(before))) qualifiers.push(entry);
    }
  }
  const prices: string[] = [];
  const currencies: string[] = [];
  for (const match of t.matchAll(CURRENCY)) {
    const symbol = symbolOf(match[1] ?? match[6] ?? '');
    const amount = match[1] ? plain(match[2] ?? '', match[3]) : plain(match[4] ?? '', match[5]);
    prices.push(`${symbol}${amount}`);
    currencies.push(symbol);
  }
  const periods: string[] = [];
  for (const [i, word] of words.entries()) {
    const clean = word.replace(/[^\p{L}/]/gu, '');
    const prev = (words[i - 1] ?? '').replace(/[^\p{L}/]/gu, '');
    const period = PERIOD_WORDS[clean.replace(/^\//, '')];
    if (!period) continue;
    if (/^(?:monthly|yearly|annual|annually|weekly|daily|hourly|quarterly|annum)$/.test(clean) || /^(?:per|each|a|\/)$/.test(prev) || clean.startsWith('/')) periods.push(period);
  }
  return { numbers: [...new Set(numbers)], prices: [...new Set(prices)], currencies: [...new Set(currencies)], periods: [...new Set(periods)], units, qualifiers: [...new Set(qualifiers)] };
}

/** What kind of claim a text is, which decides how strictly it is checked. */
export function claimType(text: string, config: ClaimConfig = defaultClaimConfig): ClaimType {
  const t = normalizeForQuote(text);
  const facts = extractFacts(t, config);
  const editorial = new RegExp(`(?<![\\p{L}\\p{N}])\\d+\\s+(?:${config.editorialNouns.map(escapeRegex).join('|')})(?![\\p{L}])`, 'u').test(t);
  if (editorial && facts.numbers.length === 1 && facts.currencies.length === 0 && !/%/.test(t)) return 'subjective';
  if (present(config.guarantees, t).length > 0) return 'guarantee';
  if (present(config.superlatives, t).length > 0) return 'superlative';
  if (facts.currencies.length > 0) return 'price';
  if (present(config.timeSensitive, t).length > 0) return 'time_sensitive';
  if (facts.numbers.length > 0) return 'numeric';
  const verbs = new Set(config.capabilityVerbs);
  if (t.split(/[^\p{L}']+/u).some((w) => verbs.has(w))) return 'capability';
  return 'subjective';
}

const wordsOf = (text: string): string[] => normalizeForQuote(text).split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}#$€£₹¥]+|[^\p{L}\p{N}%]+$/gu, '')).filter(Boolean);

/** True when a negation stands within a few words before the word at `index`. */
function negatedBefore(words: string[], index: number, config: ClaimConfig): boolean {
  const negations = new Set(config.negations);
  return words.slice(Math.max(0, index - config.negationWindow), index).some((w) => negations.has(w) || w.endsWith("n't"));
}

const sameUrl = (a: string, b: string): boolean => {
  const norm = (u: string): string => {
    try {
      const url = new URL(u);
      return url.origin.replace(/^(https?:\/\/)www\./, '$1') + url.pathname.replace(/\/+$/, '');
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
};

const reject = (claim: ClaimInput, type: ClaimType, extracted: VerifiedClaim['extracted'], page: PageSource | undefined, quoteFound: boolean, reasons: string[], confidence: number): VerifiedClaim => ({
  text: claim.text,
  type,
  source: { url: claim.sourceUrl, verbatimQuote: claim.quote, fetchedAt: page?.fetchedAt ?? null, contentHash: page ? sha256(normalizeForQuote(page.text)) : null },
  extracted,
  verification: { quoteFound, status: 'rejected', confidence, reasons },
});

/** Checks one claim against the pages that were read. Returns the claim with its source, what it states and the outcome of every check. */
export function verifyClaim(input: ClaimInput, pages: readonly PageSource[], options: VerifyOptions): VerifiedClaim {
  const config = merge(options.config);
  const claim: ClaimInput = { text: input.text, sourceUrl: input.sourceUrl, quote: input.quote };
  const type = claimType(claim.text, config);
  const facts = extractFacts(claim.text, config);
  const extracted = { numbers: facts.numbers, currencies: facts.currencies, periods: facts.periods, qualifiers: facts.qualifiers.map((q) => alternatives(q)[0] ?? q) };

  const page = pages.find((p) => sameUrl(p.url, claim.sourceUrl));
  if (!page) return reject(claim, type, extracted, undefined, false, [`the source page was not read: ${claim.sourceUrl}`], 0);
  const pageText = normalizeForQuote(page.text);
  const quote = normalizeForQuote(claim.quote);
  if (quote.length === 0 || !pageText.includes(quote)) return reject(claim, type, extracted, page, false, ['the quote was not found on the source page'], 0.1);

  const failures: string[] = [];
  const warnings: string[] = [];
  let checks = 0;
  let passed = 0;
  const check = (ok: boolean, onFail: string, severity: 'reject' | 'warn'): void => {
    checks += 1;
    if (ok) passed += 1;
    else (severity === 'reject' ? failures : warnings).push(onFail);
  };

  const proof = extractFacts(quote, config);
  const quoteWords = wordsOf(quote);
  const editorial = type === 'subjective' && facts.numbers.length > 0;

  // Layer 2: the quote supports the claim.
  if (!editorial) {
    for (const number of facts.numbers) check(proof.numbers.includes(number), `the claim states ${number}, which the quote does not contain`, 'reject');
    for (const price of facts.prices) check(proof.prices.includes(price), `the claim states the price ${price}, which the quote does not give in that currency`, 'reject');
    for (const [number, unit] of facts.units) {
      const found = proof.units.some(([n, u]) => n === number && u === unit) || (() => {
        const t = quote.split(/\s+/);
        const at = t.findIndex((w) => extractFacts(w, config).numbers.includes(number));
        return at >= 0 && t.slice(at + 1, at + 4).some((w) => stem(w.replace(/[^\p{L}]/gu, '')) === unit);
      })();
      check(found, `the claim says "${number} ${unit}", but the quote does not give that unit`, 'reject');
    }
    for (const period of facts.periods) check(proof.periods.includes(period), `the claim says "per ${period}", but the quote says ${proof.periods.length ? `"per ${proof.periods.join(' / ')}"` : 'nothing about the billing period'}`, 'reject');
    if (type === 'price' && facts.periods.length === 0 && proof.periods.length > 0) check(false, `the claim leaves out the billing period of the quote ("${proof.periods[0]}")`, 'warn');
  }
  // Negation: the quote must not say the opposite near the things the claim relies on. Looked for sentence by sentence, so a negation in
  // one sentence of the quote never counts against a claim made by another.
  const claimNegated = wordsOf(claim.text).some((w) => config.negations.includes(w) || w.endsWith("n't"));
  const sentences = quote.split(/(?<=[.!?;])\s+/).map(wordsOf).filter((words) => words.length > 0);
  if (!claimNegated) {
    const keywords = [...present(config.guarantees, claim.text), ...present(config.superlatives, claim.text)].flatMap((entry) => alternatives(entry).map((a) => a.split(' ').map((p) => p.replace(/[^\p{L}\p{N}#]/gu, ''))));
    const mainWords = [...new Set(wordsOf(claim.text).filter((w) => [...w].length >= 5 && !/\d/.test(w)))];
    let negated: string | undefined;
    for (const words of sentences) {
      for (const [i, w] of words.entries()) {
        const isNumber = facts.numbers.some((n) => extractFacts(w, config).numbers.includes(n));
        const isKeyword = keywords.some((parts) => parts.every((p, k) => words[i + k] === p));
        const isMainWord = w.length >= 5 && mainWords.some((m) => m === w || m.slice(0, 5) === w.slice(0, 5));
        // Numbers and keywords look back a few words; an ordinary word only when the negation sits right against it.
        const window = isNumber || isKeyword ? config.negationWindow : isMainWord ? 2 : 0;
        if (window > 0 && negatedBefore(words, i, { ...config, negationWindow: window })) negated ??= w;
      }
    }
    check(!negated, `the quote negates it: a negation stands before "${negated ?? ''}"`, 'reject');
  }
  // A claim that is itself negated, against a quote with no negation, says the opposite of its source.
  if (claimNegated) {
    const quoteNegated = quoteWords.some((w) => config.negations.includes(w) || w.endsWith("n't"));
    check(quoteNegated, 'the claim negates what the quote says: it says the opposite of its source', 'reject');
  }
  // Wording: a claim that shares little of its words with the quote may mean something else, which a word check cannot judge.
  const longWords = [...new Set(wordsOf(claim.text).filter((w) => [...w].length >= 5 && !/\d/.test(w)))];
  if (longWords.length >= 2) {
    const inQuote = (w: string): boolean => quoteWords.some((q) => q === w || (q.length >= 5 && w.length >= 5 && q.slice(0, 5) === w.slice(0, 5)));
    const share = longWords.filter(inQuote).length / longWords.length;
    check(share >= config.minWordOverlap, `the quote shares little wording with the claim (${Math.round(share * 100)}% of its longer words), so the claim needs review`, 'warn');
  }
  // Qualifiers of the quote must survive in the claim.
  for (const entry of proof.qualifiers) check(facts.qualifiers.includes(entry), `the claim leaves out the qualifier "${alternatives(entry)[0]}" that the quote puts on its number`, 'warn');

  // Layer 3: rules for the kind of claim.
  if (type === 'superlative') {
    for (const entry of present(config.superlatives, claim.text)) check(present([entry], claim.quote).length > 0, `the source does not make this claim itself ("${alternatives(entry)[0]}")`, 'reject');
  }
  if (type === 'guarantee') {
    for (const entry of present(config.guarantees, claim.text)) check(present([entry], claim.quote).length > 0, `the source gives no explicit "${alternatives(entry)[0]}"`, 'reject');
  }
  if (type === 'time_sensitive') {
    const fetched = page.fetchedAt ? Date.parse(page.fetchedAt) : Number.NaN;
    const ageDays = (options.now.getTime() - fetched) / 86_400_000;
    check(Number.isFinite(ageDays) && ageDays <= config.maxAgeDays, Number.isFinite(ageDays) ? `the page was read ${Math.round(ageDays)} days ago, longer than ${config.maxAgeDays} days, so a claim about now needs re-checking` : 'when the page was read is not known, so a claim about now needs re-checking', 'warn');
  }

  const status: ClaimStatus = failures.length > 0 ? 'rejected' : warnings.length > 0 ? 'uncertain' : 'verified';
  const share = checks === 0 ? 1 : passed / checks;
  const confidence = status === 'verified' ? 0.9 + 0.1 * share : status === 'uncertain' ? 0.5 + 0.2 * share : 0.05 + 0.15 * share;
  const reasons = status === 'verified' ? ['the quote is on the source page and supports the claim'] : [...failures, ...warnings];
  return {
    text: claim.text,
    type,
    source: { url: claim.sourceUrl, verbatimQuote: claim.quote, fetchedAt: page.fetchedAt ?? null, contentHash: sha256(pageText) },
    extracted,
    verification: { quoteFound: true, status, confidence: Math.round(confidence * 1000) / 1000, reasons },
  };
}

/** Checks the claim again against the pages as they are now: a page that changed since is flagged, or fails if the quote is gone. */
export function reverifyClaim(previous: VerifiedClaim, pages: readonly PageSource[], options: VerifyOptions): VerifiedClaim {
  const again = verifyClaim({ text: previous.text, sourceUrl: previous.source.url, quote: previous.source.verbatimQuote }, pages, options);
  const changed = previous.source.contentHash !== null && again.source.contentHash !== null && previous.source.contentHash !== again.source.contentHash;
  if (!changed || again.verification.status === 'rejected') return again;
  return { ...again, verification: { ...again.verification, status: 'uncertain', confidence: Math.min(again.verification.confidence, 0.7), reasons: ['the source page changed since the claim was recorded, so it needs re-checking', ...again.verification.reasons] } };
}

export interface ClaimBatch {
  verified: VerifiedClaim[];
  uncertain: VerifiedClaim[];
  rejected: VerifiedClaim[];
  /** Every claim, in the order given. */
  all: VerifiedClaim[];
}

export function verifyClaims(inputs: readonly ClaimInput[], pages: readonly PageSource[], options: VerifyOptions): ClaimBatch {
  const all = inputs.map((input) => verifyClaim(input, pages, options));
  return { verified: all.filter((c) => c.verification.status === 'verified'), uncertain: all.filter((c) => c.verification.status === 'uncertain'), rejected: all.filter((c) => c.verification.status === 'rejected'), all };
}

/** A claim that came with no source or quote: it cannot be checked, so it is rejected and recorded as such. */
export function unsourcedClaim(text: string, config?: Partial<ClaimConfig>): VerifiedClaim {
  const merged = merge(config);
  const facts = extractFacts(text, merged);
  return {
    text,
    type: claimType(text, merged),
    source: { url: '', verbatimQuote: '', fetchedAt: null, contentHash: null },
    extracted: { numbers: facts.numbers, currencies: facts.currencies, periods: facts.periods, qualifiers: facts.qualifiers.map((q) => alternatives(q)[0] ?? q) },
    verification: { quoteFound: false, status: 'rejected', confidence: 0, reasons: ['no source page and quote were given, so it cannot be checked (unsourced)'] },
  };
}
