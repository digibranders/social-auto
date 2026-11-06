/**
 * One evidence-preserving rewrite of a candidate whose copy said more than its source fact. The writer is told exactly which words were unsupported
 * and why, and given the source quote and what must survive (the fact's negations, its qualifiers, its plan name); the answer is only believed if it
 * keeps all of that, brings in no new figure, price or period, makes no claim of the kinds the engine holds back, and still states the SAME fact. The
 * rewritten copy then goes through every check again, like any other copy. Only an eligible fact is ever rewritten: a held fact never reaches here,
 * and there is one rewrite per candidate, never a loop.
 */
import type { AiConfig } from './ai.ts';
import { defaultClaimConfig, extractFacts, normalizeForQuote } from './claims.ts';
import { checkCopy } from './copy-gate.ts';
import type { EvidenceFact } from './evidence.ts';
import { chatJson } from './llm.ts';
import type { ClaimVerdict } from './claim-verdict.ts';
import { assessProofClaim } from './proof-hold.ts';

/** The headline limit the rest of the copy stage enforces (60); the writer is asked for 45 and the check allows this much. */
const MAX_REWRITE_HEADLINE = 60;

export interface RewriteRequest {
  factId: string;
  sourceQuote: string;
  failedHeadline: string;
  failedSubline: string;
  failedCaption: string;
  violations: ClaimVerdict['violations'];
  /** Qualifier words of the source ("up to", "from") that must stay in any copy that states its figure. */
  requiredQualifiers: string[];
  /** Negation words of the source ("never", "not", "no") that must stay: the rewrite must not turn a denial into a promise. */
  requiredNegations: string[];
  /** The plan, card or column the fact belongs to, which must be named next to any figure of it. */
  requiredPlanName: string | null;
  /** The longest headline that will be accepted, in characters. */
  maxHeadlineChars: number;
}

export interface Rewrite {
  factId: string;
  headline: string;
  subline: string;
  caption: string;
}

const tokens = (text: string): string[] => normalizeForQuote(text).split(/[^\p{L}\p{N}']+/u).filter(Boolean);

export function buildRewriteRequest(draft: { headline: string; subline: string; caption: string }, fact: EvidenceFact, violations: ClaimVerdict['violations']): RewriteRequest {
  const quote = tokens(fact.source.quote);
  const negations = defaultClaimConfig.negations.filter((n) => quote.includes(n.toLowerCase()));
  const qualifiers = extractFacts(fact.source.quote).qualifiers.map((q) => q.split('|')[0] as string);
  return {
    factId: fact.id,
    sourceQuote: fact.source.quote,
    failedHeadline: draft.headline.replace(/\|/g, ''),
    failedSubline: draft.subline,
    failedCaption: draft.caption,
    violations,
    requiredQualifiers: qualifiers,
    requiredNegations: negations,
    requiredPlanName: fact.scope ?? null,
    maxHeadlineChars: 45,
  };
}

/** Every reason the rewrite may not be used; empty when it may go on to the ordinary checks. */
export function validateRewrite(request: RewriteRequest, rewrite: Rewrite, fact: EvidenceFact): string[] {
  const problems: string[] = [];
  if (rewrite.factId !== request.factId) problems.push(`it is about fact ${rewrite.factId}, not ${request.factId}: a rewrite never changes the fact`);
  if (rewrite.headline.trim() === '') problems.push('the headline is empty');
  if (rewrite.headline.replace(/\|/g, '').length > MAX_REWRITE_HEADLINE) problems.push(`the headline is ${rewrite.headline.replace(/\|/g, '').length} characters; it must be at most ${MAX_REWRITE_HEADLINE}`);
  const all = `${rewrite.headline}\n${rewrite.subline}\n${rewrite.caption}`;
  const said = tokens(all);
  const normalizedAll = ` ${said.join(' ')} `;
  for (const n of request.requiredNegations) if (!said.includes(n.toLowerCase())) problems.push(`it drops the negation "${n}" of the source`);
  for (const q of request.requiredQualifiers) {
    const options = q.split('|').map((o) => tokens(o).join(' '));
    if (!options.some((o) => normalizedAll.includes(` ${o} `))) problems.push(`it drops the qualifier "${q}" of the source`);
  }
  const quoted = extractFacts(fact.source.quote);
  const wrote = extractFacts(all);
  for (const n of wrote.numbers) if (!quoted.numbers.includes(n)) problems.push(`it states ${n}, which the source does not`);
  for (const p of wrote.prices) if (!quoted.prices.includes(p)) problems.push(`it states the price ${p}, which the source does not`);
  for (const p of wrote.periods) if (!quoted.periods.includes(p)) problems.push(`it states a period "${p}", which the source does not`);
  for (const p of quoted.periods) if (wrote.prices.length > 0 && !wrote.periods.includes(p)) problems.push(`it states a price without its period "per ${p}"`);
  if (request.requiredPlanName && wrote.numbers.length > 0) {
    const plan = tokens(request.requiredPlanName).filter((w) => w.length >= 3);
    if (plan.length > 0 && !plan.some((w) => tokens(rewrite.headline).includes(w))) problems.push(`it states a figure of the "${request.requiredPlanName}" plan in the headline without naming the plan`);
  }
  for (const sentence of all.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)) {
    const proof = assessProofClaim(sentence, { context: fact.source.quote });
    if (proof.decision === 'HOLD' && proof.code !== 'HOLD_STALE_OFFER' && proof.code !== 'HOLD_PRICE_QUALIFIER' && proof.code !== 'HOLD_ELIGIBILITY') problems.push(`"${sentence.slice(0, 60)}": ${proof.reason}`);
  }
  for (const v of checkCopy({ headline: rewrite.headline, subline: rewrite.subline, caption: rewrite.caption }, [fact.source.quote, fact.text])) {
    if (!v.reason.startsWith('a proof claim is not used')) problems.push(`"${v.sentence.slice(0, 60)}": ${v.reason}`);
  }
  const unchanged = normalizeForQuote(rewrite.headline) === normalizeForQuote(request.failedHeadline) && normalizeForQuote(rewrite.caption) === normalizeForQuote(request.failedCaption);
  if (unchanged) problems.push('it is the same as the draft that failed');
  return [...new Set(problems)];
}

const REWRITE_SYSTEM = `You rewrite a social media post whose copy said more than its source says. You are given the source quote, the draft, and the exact words that are not supported with the reason. Rewrite the headline, the subline and the caption so that they say only what the source quote says, in plain words: narrow the claim, never invent a new one. You MUST keep every qualifier, negation and plan name listed in the request, keep the same fact, and add no figure, price, period, guarantee, superlative or benefit that the source does not state. The headline is at most 45 characters, a short plain statement (never longer: a longer one is thrown away). The subline is at most 70 characters and may be an empty string. The caption has short paragraphs separated by blank lines and no hashtags and no call to action. Return JSON only: {"factId":"...","headline":"...","subline":"...","caption":"..."}`;

/** Asks the writer once for the rewrite. The answer is only a candidate: validateRewrite and the ordinary checks decide. */
export async function rewriteCandidate(ai: AiConfig, request: RewriteRequest, fetchFn?: typeof fetch): Promise<Rewrite> {
  return chatJson({
    ai,
    ...(fetchFn ? { fetchFn } : {}),
    system: REWRITE_SYSTEM,
    user: JSON.stringify(request),
    parse: (v) => {
      const r = v as Partial<Rewrite>;
      if (typeof r.factId !== 'string' || typeof r.headline !== 'string' || typeof r.caption !== 'string') throw new Error('the rewrite needs factId, headline and caption as text');
      return { factId: r.factId, headline: r.headline.trim(), subline: typeof r.subline === 'string' ? r.subline.trim() : '', caption: r.caption.trim() };
    },
  });
}
