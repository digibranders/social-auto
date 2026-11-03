/**
 * The claim gate on post copy. A headline, subline or caption may state a number, price, superlative, guarantee or deadline only when a
 * verified claim (see claims.ts) states the same thing. The gate runs on the text the model wrote, before any picture is paid for, and
 * names every sentence it turns back so the model can rewrite it or drop it. It works on facts, never on industry words, and its word
 * lists are the claim settings.
 */
import { claimType, defaultClaimConfig, extractFacts, normalizeForQuote, present, stem, type ClaimConfig } from './claims.ts';

export interface PostCopy {
  headline: string;
  subline: string;
  caption: string;
}

export type CopyField = keyof PostCopy;

export interface CopyViolation {
  field: CopyField;
  sentence: string;
  reason: string;
}

export interface CopyGateConfig extends Partial<ClaimConfig> {
  /** Time words that are calls to action, not deadlines ("start today"). */
  ctaTimeWords?: readonly string[];
}

const FIELDS: readonly CopyField[] = ['headline', 'subline', 'caption'];
const DEFAULT_CTA_TIME_WORDS = ['now', 'today', 'currently'];

/** What a sentence leans on: the facts a verified claim must give. */
interface Needs {
  numbers: string[];
  prices: string[];
  periods: string[];
  qualifiers: string[];
  units: Array<[string, string]>;
  words: string[];
}

interface Offered extends Needs {
  text: string;
}

const UNITS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Readonly<Record<string, number>> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Readonly<Record<string, number>> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };
const alt = (words: Readonly<Record<string, number>>): string => Object.keys(words).join('|');
const SPELLED = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:${alt(TENS)})(?:[- ](?:${alt(UNITS)}))?|${alt(UNITS)})(?:\\s+(?:${alt(SCALES)}))*(?![\\p{L}\\p{N}])`,
  'giu',
);

/**
 * Number words as digits, so "ten hours" is checked like "10 hours". A lone "one" is left alone ("one place", "one tool"); "one hundred"
 * and "twenty-one" are numbers.
 */
export function withDigits(text: string): string {
  return text.replace(SPELLED, (run) => {
    const words = run.toLowerCase().split(/[-\s]+/);
    if (words.length === 1 && words[0] === 'one') return run;
    let total = 0;
    let current = 0;
    for (const word of words) {
      const unit = UNITS[word] ?? TENS[word];
      if (unit !== undefined) current += unit;
      else {
        const scale = SCALES[word] ?? 1;
        if (scale === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * scale;
          current = 0;
        }
      }
    }
    return String(total + current);
  });
}

const sentencesOf = (text: string): string[] =>
  withDigits(text.replaceAll('|', '')).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

function needsOf(sentence: string, config: ClaimConfig, ctaTimeWords: readonly string[]): Needs | undefined {
  const type = claimType(sentence, config);
  if (type === 'subjective' || type === 'capability') return undefined;
  const facts = extractFacts(sentence, config);
  const time = present(config.timeSensitive, sentence).filter((entry) => !ctaTimeWords.includes(entry));
  const words = [...present(config.superlatives, sentence), ...present(config.guarantees, sentence), ...time];
  const needs: Needs = { numbers: facts.numbers, prices: facts.prices, periods: facts.periods, qualifiers: facts.qualifiers, units: facts.units, words };
  const any = needs.numbers.length + needs.prices.length + needs.periods.length + needs.words.length;
  return any > 0 ? needs : undefined;
}

function offeredBy(text: string, config: ClaimConfig, ctaTimeWords: readonly string[]): Offered {
  const spelled = withDigits(text);
  const facts = extractFacts(spelled, config);
  const time = present(config.timeSensitive, spelled).filter((entry) => !ctaTimeWords.includes(entry));
  const words = [...present(config.superlatives, spelled), ...present(config.guarantees, spelled), ...time];
  return { text: normalizeForQuote(spelled), numbers: facts.numbers, prices: facts.prices, periods: facts.periods, qualifiers: facts.qualifiers, units: facts.units, words };
}

/** The unit may stand a word or two after the number in the evidence ("25 supported integrations"). */
function hasUnit(offered: Offered, number: string, unit: string): boolean {
  if (offered.units.some(([n, u]) => n === number && u === unit)) return true;
  const words = offered.text.split(/\s+/);
  const at = words.findIndex((w) => extractFacts(w).numbers.includes(number));
  return at >= 0 && words.slice(at + 1, at + 4).some((w) => stem(w.replace(/[^\p{L}]/gu, '')) === unit);
}

interface Fact {
  label: string;
  covered: (offered: Offered) => boolean;
}

const factsOf = (needs: Needs): Fact[] => [
  ...needs.numbers.map((n) => ({ label: n, covered: (o: Offered) => o.numbers.includes(n) })),
  ...needs.prices.map((p) => ({ label: p, covered: (o: Offered) => o.prices.includes(p) })),
  ...needs.units.map(([n, u]) => ({ label: `${n} ${u}`, covered: (o: Offered) => hasUnit(o, n, u) })),
  ...needs.periods.map((p) => ({ label: `per ${p}`, covered: (o: Offered) => o.periods.includes(p) })),
  ...needs.qualifiers.map((q) => ({ label: q.split('|')[0] ?? q, covered: (o: Offered) => o.qualifiers.includes(q) })),
  ...needs.words.map((w) => ({ label: w.split('|')[0] ?? w, covered: (o: Offered) => o.words.includes(w) })),
];

/** The reason a sentence is turned back, or undefined when one verified claim states everything it leans on. */
function unsupported(needs: Needs, evidence: readonly Offered[]): string | undefined {
  const facts = factsOf(needs);
  if (evidence.some((o) => facts.every((f) => f.covered(o)))) return undefined;
  const missing = facts.filter((f) => !evidence.some((o) => f.covered(o))).map((f) => f.label);
  if (missing.length > 0) return `states ${[...new Set(missing)].join(', ')}, which no verified claim supports`;
  return 'puts facts together that come from different claims, so no verified claim states them together';
}

/** Every sentence of the copy that states a checkable fact no verified claim supports. */
export function checkCopy(copy: PostCopy, evidence: readonly string[], options: CopyGateConfig = {}): CopyViolation[] {
  const { ctaTimeWords, ...overrides } = options;
  const config: ClaimConfig = { ...defaultClaimConfig, ...overrides };
  const cta = (ctaTimeWords ?? DEFAULT_CTA_TIME_WORDS).map((w) => w.toLowerCase());
  const offered = evidence.map((text) => offeredBy(text, config, cta));
  const violations: CopyViolation[] = [];
  for (const field of FIELDS) {
    for (const sentence of sentencesOf(copy[field] ?? '')) {
      const needs = needsOf(sentence, config, cta);
      if (!needs) continue;
      const reason = unsupported(needs, offered);
      if (reason) violations.push({ field, sentence, reason });
    }
  }
  return violations;
}

const shorten = (text: string): string => (text.length > 80 ? `${text.slice(0, 77)}...` : text);

/** Throws one message naming the post and every sentence turned back, written so the model can fix them on the next try. */
export function assertCopySupported(copy: PostCopy, evidence: readonly string[], position: number, options: CopyGateConfig = {}): void {
  const violations = checkCopy(copy, evidence, options);
  if (violations.length === 0) return;
  const lines = violations.map((v) => `${v.field} "${shorten(v.sentence)}" ${v.reason}`);
  throw new Error(`post ${position} states facts the brand profile does not support: ${lines.join('; ')}. Remove them, or use only the numbers, prices and wording of the proof points`);
}
