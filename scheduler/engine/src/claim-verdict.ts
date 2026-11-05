/**
 * The verdict of the model that checks whether a post's words are supported by its source fact, made impossible to be vague. The model must say
 * WHAT is unsupported and cite the source, and code checks every part of its answer against the draft and against the stored evidence before it is
 * believed:
 *
 *   SUPPORTED    valid only if the coverage maps EVERY material sentence of the headline, subline and caption to a source quote; one quote cannot
 *                approve unrelated assertions. Anything the coverage does not account for makes the verdict invalid.
 *   UNSUPPORTED  valid only if at least one violation names text that is really in the draft and explains the mismatch; then the draft is
 *                rewritten once.
 *   UNCERTAIN    valid only if it names the disputed text and the question; then one focused adjudication is made.
 *
 * A malformed or vague verdict is not a verdict: it goes to one focused adjudication and, if that is no better, the candidate is dropped.
 * A quote the model cites that is not in the stored evidence makes the verdict invalid (a model may not invent its own sources).
 * A deterministic hold always wins over the model.
 */
import { normalizeForQuote } from './claims.ts';
import { sentencesOf } from './evidence.ts';

export type VerdictField = 'headline' | 'subline' | 'caption';
export type VerdictDecision = 'SUPPORTED' | 'UNSUPPORTED' | 'UNCERTAIN';

export interface ClaimVerdict {
  decision: VerdictDecision;
  factId: string;
  coverage: Array<{ field: VerdictField; claimText: string; sourceQuote: string }>;
  violations: Array<{ field: VerdictField; unsupportedText: string; reasonCode: string; explanation: string; sourceContext: string }>;
  uncertainty?: { disputedText: string; questionToResolve: string };
}

export interface DraftTexts {
  headline: string;
  subline: string;
  /** The caption without its call-to-action line and hashtags. */
  caption: string;
}

export type VerdictAction =
  | { action: 'continue' }
  | { action: 'rewrite'; violations: ClaimVerdict['violations'] }
  | { action: 'adjudicate'; problems: string[] }
  | { action: 'drop'; problems: string[] };

const FIELDS: readonly string[] = ['headline', 'subline', 'caption'];

/** Reads the model's JSON into a verdict, or says why it is not one. */
export function parseClaimVerdict(value: unknown): ClaimVerdict {
  const raw = value as Record<string, unknown>;
  const decision = raw['decision'];
  if (decision !== 'SUPPORTED' && decision !== 'UNSUPPORTED' && decision !== 'UNCERTAIN') throw new Error('"decision" must be SUPPORTED, UNSUPPORTED or UNCERTAIN');
  if (typeof raw['factId'] !== 'string') throw new Error('"factId" must be text');
  const list = (name: string): unknown[] => {
    const v = raw[name];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`"${name}" must be a list`);
    return v;
  };
  const text = (o: Record<string, unknown>, key: string): string => (typeof o[key] === 'string' ? (o[key] as string) : '');
  const field = (o: Record<string, unknown>): VerdictField => {
    if (typeof o['field'] !== 'string' || !FIELDS.includes(o['field'])) throw new Error('every entry needs "field": headline, subline or caption');
    return o['field'] as VerdictField;
  };
  const verdict: ClaimVerdict = {
    decision,
    factId: raw['factId'],
    coverage: list('coverage').map((c) => ({ field: field(c as Record<string, unknown>), claimText: text(c as Record<string, unknown>, 'claimText'), sourceQuote: text(c as Record<string, unknown>, 'sourceQuote') })),
    violations: list('violations').map((v) => ({ field: field(v as Record<string, unknown>), unsupportedText: text(v as Record<string, unknown>, 'unsupportedText'), reasonCode: text(v as Record<string, unknown>, 'reasonCode'), explanation: text(v as Record<string, unknown>, 'explanation'), sourceContext: text(v as Record<string, unknown>, 'sourceContext') })),
  };
  const u = raw['uncertainty'];
  if (u !== undefined && u !== null) verdict.uncertainty = { disputedText: text(u as Record<string, unknown>, 'disputedText'), questionToResolve: text(u as Record<string, unknown>, 'questionToResolve') };
  return verdict;
}

const tokens = (text: string): string[] => normalizeForQuote(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const contains = (haystack: string, needle: string): boolean => needle.trim() !== '' && ` ${tokens(haystack).join(' ')} `.includes(` ${tokens(needle).join(' ')} `);

/** The sentences of the draft that make a claim: the headline, the subline, and each sentence of the caption. */
export function materialSentences(draft: DraftTexts): Array<{ field: VerdictField; text: string }> {
  const out: Array<{ field: VerdictField; text: string }> = [];
  if (draft.headline.trim()) out.push({ field: 'headline', text: draft.headline.replace(/\|/g, '').trim() });
  if (draft.subline.trim()) out.push({ field: 'subline', text: draft.subline.trim() });
  for (const line of draft.caption.split(/\n+/)) {
    const clean = line.trim();
    if (clean === '' || clean.startsWith('#')) continue;
    for (const sentence of sentencesOf(clean)) if (tokens(sentence).length >= 3) out.push({ field: 'caption', text: sentence });
  }
  return out;
}

/** Whether a claim text accounts for a sentence: it contains it, or it is contained in it and covers most of its words. */
function accounts(claimText: string, sentence: string): boolean {
  const a = tokens(claimText);
  const b = tokens(sentence);
  if (a.length === 0 || b.length === 0) return false;
  if (contains(claimText, sentence)) return true;
  return contains(sentence, claimText) && a.length / b.length >= 0.6;
}

export function assessVerdict(verdict: ClaimVerdict, draft: DraftTexts, evidence: { factId: string; quotes: readonly string[] }, options: { deterministicHold?: boolean } = {}): VerdictAction {
  if (options.deterministicHold) return { action: 'drop', problems: ['a deterministic claim check holds this copy, and that always wins over the model'] };
  const problems: string[] = [];
  const quoted = (q: string): boolean => q.trim() === '' || evidence.quotes.some((e) => contains(e, q));
  const whole = `${draft.headline}\n${draft.subline}\n${draft.caption}`;
  if (verdict.factId !== evidence.factId) problems.push(`the verdict is about fact ${verdict.factId}, not ${evidence.factId}`);
  for (const c of verdict.coverage) if (!quoted(c.sourceQuote) || c.sourceQuote.trim() === '') problems.push(`the quote "${c.sourceQuote.slice(0, 60)}" is not in the stored evidence`);
  for (const v of verdict.violations) if (v.sourceContext.trim() !== '' && !quoted(v.sourceContext)) problems.push(`the context "${v.sourceContext.slice(0, 60)}" is not in the stored evidence`);

  if (verdict.decision === 'SUPPORTED') {
    for (const sentence of materialSentences(draft)) {
      if (!verdict.coverage.some((c) => c.field === sentence.field && accounts(c.claimText, sentence.text))) problems.push(`the ${sentence.field} sentence "${sentence.text.slice(0, 70)}" is not accounted for by any quote`);
    }
    return problems.length === 0 ? { action: 'continue' } : { action: 'adjudicate', problems };
  }
  if (verdict.decision === 'UNSUPPORTED') {
    if (verdict.violations.length === 0) problems.push('it says unsupported but names no violation');
    for (const v of verdict.violations) {
      if (v.unsupportedText.trim() === '') problems.push('a violation names no text');
      else if (!contains(whole, v.unsupportedText)) problems.push(`the violation names "${v.unsupportedText.slice(0, 60)}", which is not in the draft`);
      if (v.explanation.trim().length < 15) problems.push('a violation gives no real explanation');
    }
    return problems.length === 0 ? { action: 'rewrite', violations: verdict.violations } : { action: 'adjudicate', problems };
  }
  const u = verdict.uncertainty;
  if (!u || u.disputedText.trim() === '' || u.questionToResolve.trim() === '') problems.push('it says uncertain but names no disputed text and question');
  else if (!contains(whole, u.disputedText)) problems.push(`the disputed text "${u.disputedText.slice(0, 60)}" is not in the draft`);
  return { action: 'adjudicate', problems };
}
