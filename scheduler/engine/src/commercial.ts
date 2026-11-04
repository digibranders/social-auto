/**
 * Commercial terms derived from evidence facts: price, trial, free plan, tax, guarantee, with the plan each belongs to. A "free plan" and a
 * "free trial" are different terms and are never merged. A tax note attaches to a plan only when the page confirmed that scope; a footnote
 * shared by the whole page is never attached by guess. Conflicts need the same plan, currency and billing period and a different amount;
 * ranges and bounds ("under 10 minutes", "up to 50") are compared as ranges, so a point inside a bound is not a contradiction.
 */
import { extractFacts, normalizeForQuote } from './claims.ts';
import type { EvidenceFact, ReasonCode } from './evidence.ts';

export type TermKind = 'price' | 'trial' | 'free_plan' | 'tax' | 'guarantee' | 'other';

export interface CommercialTerm {
  kind: TermKind;
  factId: string;
  /** The plan this term belongs to, from the fact's structure or from a plan name the sentence itself states. */
  plan?: string;
  /** Whether the plan comes from confirmed structure (true) or from a name found in the sentence (false). */
  planConfirmed: boolean;
  amount?: number;
  currency?: string;
  period?: string;
  trialDays?: number;
  qualifiers: string[];
  status: EvidenceFact['status'];
}

const has = (text: string, pattern: RegExp): boolean => pattern.test(normalizeForQuote(text));
const TRIAL = /(?<![\p{L}\p{N}])(?:trial|trials)(?![\p{L}])/u;
const FREE_PLAN = /(?<![\p{L}\p{N}])free (?:forever|plan|tier)(?![\p{L}])|^free$/u;
const TAX = /(?<![\p{L}\p{N}])(?:gst|vat|tax|taxes)(?![\p{L}])/u;
const GUARANTEE = /(?<![\p{L}\p{N}])(?:refund|money-back|money back|guarantee|guaranteed)(?![\p{L}])/u;
const norm = (text: string): string => normalizeForQuote(text);

/** The known plan names: scopes the pages gave to price facts. */
export function planNames(facts: readonly EvidenceFact[]): string[] {
  const names = new Set<string>();
  for (const fact of facts) if (fact.scope !== undefined && fact.values.prices.length > 0 && fact.associationStatus === 'confirmed') names.add(fact.scope);
  return [...names];
}

const planIn = (text: string, plans: readonly string[]): string | undefined => plans.find((plan) => new RegExp(`(?<![\\p{L}\\p{N}])${norm(plan).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(norm(text)));

function trialDaysOf(fact: EvidenceFact): number | undefined {
  const source = `${fact.label ?? ''} ${fact.text}`;
  const match = /(\d+)\s*[- ]?\s*(day|days|week|weeks)/i.exec(fact.text);
  if (!match) return undefined;
  const n = Number(match[1]);
  return /week/i.test(match[2] ?? '') && has(source, TRIAL) ? n * 7 : n;
}

export function deriveTerms(facts: readonly EvidenceFact[]): CommercialTerm[] {
  const plans = planNames(facts);
  const terms: CommercialTerm[] = [];
  for (const fact of facts) {
    if (fact.category !== 'commercial_term') continue;
    const withLabel = `${fact.label ?? ''} ${fact.text}`;
    const named = fact.scope === undefined ? planIn(fact.text, plans) : undefined;
    const base = { factId: fact.id, qualifiers: fact.qualifiers, status: fact.status, planConfirmed: fact.scope !== undefined && fact.associationStatus === 'confirmed', ...(fact.scope !== undefined ? { plan: fact.scope } : named !== undefined ? { plan: named } : {}) };
    const labelFacts = extractFacts(withLabel);
    if (fact.values.prices.length > 0) {
      const price = fact.values.prices[0] ?? '';
      terms.push({ ...base, kind: 'price', amount: Number(price.replace(/^\D+/, '')), currency: price.replace(/[\d.]+$/, ''), ...(labelFacts.periods[0] !== undefined ? { period: labelFacts.periods[0] } : {}) });
    } else if (has(withLabel, TRIAL)) {
      const days = trialDaysOf(fact);
      terms.push({ ...base, kind: 'trial', ...(days !== undefined ? { trialDays: days } : {}) });
    } else if (has(fact.text, FREE_PLAN)) terms.push({ ...base, kind: 'free_plan' });
    else if (has(fact.text, TAX)) terms.push({ ...base, kind: 'tax' });
    else if (has(fact.text, GUARANTEE)) terms.push({ ...base, kind: 'guarantee' });
    else terms.push({ ...base, kind: 'other' });
  }
  return terms;
}

export interface PlanSummary {
  plan: string;
  prices: CommercialTerm[];
  trial?: CommercialTerm;
  freePlan?: CommercialTerm;
  /** Only a tax note whose scope the page confirmed for this plan. */
  tax?: CommercialTerm;
}

/** What may be said about one plan: its usable terms, and a tax note only if confirmed for that plan. */
export function summarizePlan(terms: readonly CommercialTerm[], plan: string): PlanSummary {
  const mine = terms.filter((t) => t.status === 'usable' && t.plan !== undefined && norm(t.plan) === norm(plan));
  const confirmed = (t: CommercialTerm): boolean => t.planConfirmed;
  const trial = mine.find((t) => t.kind === 'trial');
  const freePlan = mine.find((t) => t.kind === 'free_plan');
  const tax = mine.find((t) => t.kind === 'tax' && confirmed(t));
  return { plan, prices: mine.filter((t) => t.kind === 'price'), ...(trial ? { trial } : {}), ...(freePlan ? { freePlan } : {}), ...(tax ? { tax } : {}) };
}

export interface Bound { kind: 'exact' | 'at_most' | 'at_least'; value: number }

/** True when two stated values cannot both be true: an exact value against a different exact one, or a point outside a bound, or bounds that leave no overlap. */
export function rangesConflict(a: Bound, b: Bound): boolean {
  const lo = (x: Bound): number => (x.kind === 'at_least' ? x.value : x.kind === 'exact' ? x.value : -Infinity);
  const hi = (x: Bound): number => (x.kind === 'at_most' ? x.value : x.kind === 'exact' ? x.value : Infinity);
  return Math.max(lo(a), lo(b)) > Math.min(hi(a), hi(b));
}

const AT_MOST = /\b(?:up to|under|below|less than|at most|no more than|within)\b/i;
const AT_LEAST = /\b(?:over|above|more than|at least|minimum of|exceeding)\b/i;
/** The bound a quoted number carries, from the words right before it. */
export function boundOf(text: string, value: number): Bound {
  const before = text.slice(0, Math.max(0, text.search(new RegExp(`(?<![\\d.,])${value.toLocaleString('en-US')}(?![\\d])|(?<![\\d.,])${value}(?![\\d])`)))).split(/\s+/).slice(-3).join(' ');
  return { kind: AT_MOST.test(before) ? 'at_most' : AT_LEAST.test(before) ? 'at_least' : 'exact', value };
}

export interface TermConflict { a: string; b: string; reason: string }

/** Prices of one plan, in one currency and billing period, that differ; trial lengths of one plan that differ. Only usable terms with a plan are compared. */
export function findConflicts(terms: readonly CommercialTerm[], options: { includeHeld?: boolean } = {}): TermConflict[] {
  const out: TermConflict[] = [];
  const usable = terms.filter((t) => t.plan !== undefined && (options.includeHeld === true || t.status === 'usable'));
  for (const [i, a] of usable.entries()) {
    for (const b of usable.slice(i + 1)) {
      if (norm(a.plan ?? '') !== norm(b.plan ?? '') || a.kind !== b.kind || a.factId === b.factId) continue;
      if (a.kind === 'price' && a.currency === b.currency && (a.period ?? '') === (b.period ?? '') && a.amount !== b.amount && !a.qualifiers.length && !b.qualifiers.length) {
        out.push({ a: a.factId, b: b.factId, reason: `${a.plan}: ${a.currency}${a.amount} against ${b.currency}${b.amount} per ${a.period ?? 'unstated period'}` });
      }
      if (a.kind === 'trial' && a.trialDays !== undefined && b.trialDays !== undefined && a.trialDays !== b.trialDays) {
        out.push({ a: a.factId, b: b.factId, reason: `${a.plan}: ${a.trialDays}-day trial against ${b.trialDays}-day trial` });
      }
    }
  }
  return out;
}

const withReason = (fact: EvidenceFact, code: ReasonCode): EvidenceFact => ({ ...fact, status: 'needs_review', reasonCodes: [...new Set<ReasonCode>([...fact.reasonCodes, code])] });

/** Facts with every fact in a conflict held for review. */
/** `conflictsWithHeld` are the conflicts that involve a fact already held for review: reported so that a filtered result is never mistaken for a site with no conflicts. */
export function applyConflicts(facts: readonly EvidenceFact[]): { facts: EvidenceFact[]; conflicts: TermConflict[]; conflictsWithHeld: TermConflict[] } {
  const terms = deriveTerms(facts);
  const conflicts = findConflicts(terms);
  const seen = new Set(conflicts.map((c) => `${c.a}|${c.b}`));
  const conflictsWithHeld = findConflicts(terms, { includeHeld: true }).filter((c) => !seen.has(`${c.a}|${c.b}`));
  const hit = new Set(conflicts.flatMap((c) => [c.a, c.b]));
  return { facts: facts.map((f) => (hit.has(f.id) ? withReason(f, 'conflicting_values') : f)), conflicts, conflictsWithHeld };
}

/** Commercial facts read longer ago than `maxAgeDays` are not treated as current. */
export function applyFreshness(facts: readonly EvidenceFact[], now: Date, maxAgeDays: number): EvidenceFact[] {
  return facts.map((f) => {
    if (f.category !== 'commercial_term') return f;
    const age = (now.getTime() - Date.parse(f.capturedAt)) / 86_400_000;
    return Number.isFinite(age) && age <= maxAgeDays ? f : withReason(f, 'stale_commercial_term');
  });
}
