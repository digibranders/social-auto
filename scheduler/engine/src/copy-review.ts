/**
 * Reviews candidate copy before any picture is bought, with structured verdicts (claim-verdict.ts) and at most one rewrite and one adjudication per
 * candidate (copy-rewrite.ts):
 *
 *   judge -> continue            the copy is supported; it goes on.
 *         -> rewrite             the verdict names unsupported words: one evidence-preserving rewrite, which must keep every negation, qualifier and
 *                                plan name (validateRewrite), pass the ordinary checks again (recheck) and be judged SUPPORTED, or the candidate is dropped.
 *         -> adjudicate          the verdict was vague or invalid: one focused look at exactly what was unclear; its answer is handled like a first verdict,
 *                                except that it can no longer ask for another adjudication.
 *         -> drop                a deterministic hold, or nothing that can be trusted: the candidate is dropped, never published on a guess.
 *
 * A judge that fails (a network error, an answer that is not JSON) leaves the candidate uncertain and it is dropped here: with candidates to spare, a doubtful one is not needed.
 */
import type { AiConfig } from './ai.ts';
import { checkCopy } from './copy-gate.ts';
import { brandPrefixProblem, planQualifierProblem } from './headline-rules.ts';
import { assessVerdict, parseClaimVerdict, type ClaimVerdict, type DraftTexts } from './claim-verdict.ts';
import { buildRewriteRequest, rewriteCandidate, validateRewrite, type Rewrite, type RewriteRequest } from './copy-rewrite.ts';
import type { EvidenceFact } from './evidence.ts';
import { chatJson } from './llm.ts';
import { BudgetError } from './paid-ledger.ts';

export interface ReviewInput {
  id: string;
  draft: DraftTexts;
  /** The post's facts, the first being the one it is about. */
  facts: readonly EvidenceFact[];
  /** True when a deterministic claim check already holds this copy. */
  deterministicHold?: boolean;
}

export type ReviewStep = { step: 'judge' | 'adjudicate' | 'rewrite' | 'rejudge' | 'recheck'; detail: string };

export interface ReviewOutcome {
  id: string;
  status: 'accepted' | 'dropped';
  /** The copy to use: the original, or its one rewrite. */
  draft: DraftTexts;
  rewritten: boolean;
  reasons: string[];
  trail: ReviewStep[];
}

export interface ReviewDeps {
  judge: (input: ReviewInput) => Promise<ClaimVerdict>;
  /** A focused second look at what the first verdict left unclear. */
  adjudicate: (input: ReviewInput, problems: readonly string[]) => Promise<ClaimVerdict>;
  rewrite: (request: RewriteRequest) => Promise<Rewrite>;
  /** The ordinary deterministic checks of the copy stage, run again on rewritten copy: reasons it may not be used, empty when it may. */
  recheck: (input: ReviewInput, draft: DraftTexts) => readonly string[];
}

const evidenceOf = (input: ReviewInput): { factId: string; quotes: string[] } => ({ factId: (input.facts[0] as EvidenceFact).id, quotes: input.facts.flatMap((f) => [f.source.quote, f.text, f.source.context].filter(Boolean)) });

export async function reviewCandidate(input: ReviewInput, deps: ReviewDeps): Promise<ReviewOutcome> {
  const trail: ReviewStep[] = [];
  const done = (status: ReviewOutcome['status'], draft: DraftTexts, rewritten: boolean, reasons: string[]): ReviewOutcome => ({ id: input.id, status, draft, rewritten, reasons, trail });
  if (input.facts.length === 0) return done('dropped', input.draft, false, ['the candidate has no source fact']);
  const ask = async (call: () => Promise<ClaimVerdict>, step: ReviewStep['step']): Promise<ClaimVerdict | undefined> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      trail.push({ step, detail: `the judge failed: ${error instanceof Error ? error.message : String(error)}` });
      return undefined;
    }
  };

  let verdict = await ask(() => deps.judge(input), 'judge');
  if (!verdict) return done('dropped', input.draft, false, ['the claim judge could not give a verdict']);
  let action = assessVerdict(verdict, input.draft, evidenceOf(input), { deterministicHold: input.deterministicHold === true });
  trail.push({ step: 'judge', detail: `${verdict.decision} -> ${action.action}${'problems' in action && action.problems.length > 0 ? `: ${action.problems.join('; ')}` : ''}` });

  if (action.action === 'adjudicate') {
    const problems = action.problems.length > 0 ? action.problems : [verdict.uncertainty?.questionToResolve ?? 'the verdict was unclear'];
    verdict = await ask(() => deps.adjudicate(input, problems), 'adjudicate');
    if (!verdict) return done('dropped', input.draft, false, [`the focused check could not be made (${problems.join('; ')})`]);
    action = assessVerdict(verdict, input.draft, evidenceOf(input), { deterministicHold: input.deterministicHold === true });
    trail.push({ step: 'adjudicate', detail: `${verdict.decision} -> ${action.action}${'problems' in action && action.problems.length > 0 ? `: ${action.problems.join('; ')}` : ''}` });
    // A second unclear answer is not a third chance: with nothing that can be trusted, the candidate is dropped.
    if (action.action === 'adjudicate') return done('dropped', input.draft, false, ['the verdict stayed unclear after a focused check: ' + action.problems.join('; ')]);
  }
  if (action.action === 'continue') return done('accepted', input.draft, false, []);
  if (action.action === 'drop') return done('dropped', input.draft, false, action.problems);

  // A rewrite: one, never a loop.
  const fact = input.facts[0] as EvidenceFact;
  const request = buildRewriteRequest(input.draft, fact, action.violations);
  let rewrite: Rewrite;
  try {
    rewrite = await deps.rewrite(request);
  } catch (error) {
    if (error instanceof BudgetError) throw error;
    trail.push({ step: 'rewrite', detail: `the rewrite could not be made: ${error instanceof Error ? error.message : String(error)}` });
    return done('dropped', input.draft, false, ['the copy overstated its source and could not be rewritten']);
  }
  const invalid = validateRewrite(request, rewrite, fact);
  trail.push({ step: 'rewrite', detail: invalid.length === 0 ? 'rewritten' : `refused: ${invalid.join('; ')}` });
  if (invalid.length > 0) return done('dropped', input.draft, false, [`the rewrite was refused: ${invalid.join('; ')}`]);
  const rewritten: DraftTexts = { headline: rewrite.headline, subline: rewrite.subline, caption: rewrite.caption };
  const again = deps.recheck(input, rewritten);
  trail.push({ step: 'recheck', detail: again.length === 0 ? 'passed' : again.join('; ') });
  if (again.length > 0) return done('dropped', input.draft, false, [`the rewritten copy failed the checks again: ${again.join('; ')}`]);
  const second = await ask(() => deps.judge({ ...input, draft: rewritten }), 'rejudge');
  if (!second) return done('dropped', input.draft, false, ['the rewritten copy could not be judged']);
  const final = assessVerdict(second, rewritten, evidenceOf(input));
  trail.push({ step: 'rejudge', detail: `${second.decision} -> ${final.action}` });
  return final.action === 'continue' ? done('accepted', rewritten, true, []) : done('dropped', input.draft, false, ['the rewritten copy was not judged supported']);
}

/** Reviews every candidate, a few at a time. */
export async function reviewCandidates(inputs: readonly ReviewInput[], deps: ReviewDeps, concurrency = 4): Promise<ReviewOutcome[]> {
  const out: ReviewOutcome[] = new Array<ReviewOutcome>(inputs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= inputs.length) return;
      out[i] = await reviewCandidate(inputs[i] as ReviewInput, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker));
  return out;
}

// ---- The model behind the judge

const JUDGE_SYSTEM = `You check whether a social media post's words are supported by the verified source it was written from. The source is quotes from the brand's own website. Return one verdict, in JSON only.
Decide:
- SUPPORTED: every claim the post makes (the headline, the subline and each sentence of the caption; hashtags and the call to action are not claims) is stated by the source, with the same meaning, figures, qualifiers, negations and plan names. In "coverage" list EVERY such sentence once, with the exact sourceQuote (copied word for word from the source) that supports it. A sentence you cannot support from a quote makes the verdict not SUPPORTED.
- UNSUPPORTED: something the post says is not in the source, or says more than the source does (a stronger quantity, a guarantee, a speed, a benefit, a wider scope, a dropped condition). In "violations" give, for each: "field" (headline, subline or caption), "unsupportedText" (the exact words of the post that are unsupported, copied exactly), "reasonCode" (a short code such as UNSUPPORTED_SPEED, UNSUPPORTED_SCOPE, UNSUPPORTED_BENEFIT, DROPPED_CONDITION, CHANGED_MEANING), "explanation" (one sentence saying what the source says and what the post adds) and "sourceContext" (the source words that are closest, copied exactly).
- UNCERTAIN: only if one specific phrase might or might not be supported. Give "uncertainty": {"disputedText": exact words of the post, "questionToResolve": the question that would settle it}.
Never answer UNSUPPORTED or UNCERTAIN without naming exact words of the post. Never cite words that are not in the source.
Return: {"decision":"SUPPORTED|UNSUPPORTED|UNCERTAIN","factId":"<the given factId>","coverage":[{"field":"headline","claimText":"...","sourceQuote":"..."}],"violations":[],"uncertainty":null}`;

const payload = (input: ReviewInput): string => JSON.stringify({
  factId: (input.facts[0] as EvidenceFact).id,
  source: input.facts.map((f) => ({ quote: f.source.quote, context: f.source.context, plan: f.scope ?? null })),
  post: { headline: input.draft.headline.replace(/\|/g, ''), subline: input.draft.subline, caption: input.draft.caption },
});

export function modelReviewDeps(ai: AiConfig, recheck: ReviewDeps['recheck'], fetchFn?: typeof fetch): ReviewDeps {
  const ask = (system: string, user: string): Promise<ClaimVerdict> => chatJson({ ai, ...(fetchFn ? { fetchFn } : {}), system, user, parse: parseClaimVerdict });
  return {
    judge: (input) => ask(JUDGE_SYSTEM, payload(input)),
    adjudicate: (input, problems) => ask(`${JUDGE_SYSTEM}\nA first verdict on this post could not be used. Look again, concentrating on exactly what was unclear. Decide for the whole post as before, with every sentence of the caption covered if you answer SUPPORTED.`, JSON.stringify({ ...JSON.parse(payload(input)) as object, whatWasUnclear: problems })),
    rewrite: (request) => rewriteCandidate(ai, request, fetchFn),
    recheck,
  };
}

/** The deterministic checks of the copy stage as a recheck for rewritten copy: the headline rules (no brand label, a plan keeps its name, a sensible length) and the claim gate over the post's own facts. */
export function ordinaryChecks(brandName: string): ReviewDeps['recheck'] {
  return (input, draft) => {
    const reasons: string[] = [];
    const prefix = brandPrefixProblem(draft.headline, brandName);
    if (prefix) reasons.push(prefix);
    const plan = planQualifierProblem(draft.headline, input.facts);
    if (plan) reasons.push(plan);
    if (draft.headline.replace(/\|/g, '').length > 60) reasons.push('the headline is too long');
    for (const v of checkCopy({ headline: draft.headline, subline: draft.subline, caption: draft.caption }, input.facts.flatMap((f) => [f.source.quote, f.text]))) reasons.push(`"${v.sentence.slice(0, 60)}": ${v.reason}`);
    return reasons;
  };
}
