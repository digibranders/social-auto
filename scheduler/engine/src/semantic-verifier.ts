/**
 * A pure layer that decides whether a model's paraphrase of a source quote is supported. Deterministic checks come first and are
 * authoritative: a number, price or period the paraphrase states that the quote does not, a qualifier dropped, or a source that is a target,
 * an example or a customer's result, rejects it without asking anyone. Only what passes goes to an injected judge, in batches, and each
 * answer is cached under tenant + source hash + claim + context + verifier version. A judge's "supported" is reported as
 * `supported_by_model` (never as verified), anything else stays uncertain, and a judge that fails leaves everything uncertain and caches nothing.
 * No live call is made here; the judge is whatever the caller passes in.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { extractFacts, normalizeForQuote } from './claims.ts';
import type { EvidenceFact } from './evidence.ts';

export const VERIFIER_VERSION = 1;

export type JudgeAnswer = 'supported' | 'unsupported' | 'unclear';
export interface JudgeItem { key: string; claim: string; quote: string; context: string }
export interface JudgeVerdict { key: string; answer: JudgeAnswer; /** One line from the judge on what the copy adds, when it gave one. */ reason?: string }
export type Judge = (items: JudgeItem[]) => Promise<JudgeVerdict[]>;

export interface VerdictCache {
  get(key: string): JudgeAnswer | undefined;
  set(key: string, answer: JudgeAnswer): void;
}

export const memoryCache = (): VerdictCache => {
  const store = new Map<string, JudgeAnswer>();
  return { get: (key) => store.get(key), set: (key, answer) => void store.set(key, answer) };
};

const ANSWERS: readonly string[] = ['supported', 'unsupported', 'unclear'];

/** A cache kept in a JSON file, written atomically. Load once, save after a batch. */
export async function fileCache(path: string): Promise<VerdictCache & { save(): Promise<void> }> {
  const store = new Map<string, JudgeAnswer>();
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof raw === 'object' && raw !== null) for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && ANSWERS.includes(v)) store.set(k, v as JudgeAnswer);
  } catch {
    // no cache yet, or an unreadable one: start empty
  }
  return {
    get: (key) => store.get(key),
    set: (key, answer) => void store.set(key, answer),
    async save() {
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(Object.fromEntries(store)));
      await rename(temp, path);
    },
  };
}

export type SemanticStatus = 'rejected' | 'supported_by_model' | 'uncertain';
export interface SemanticResult { claim: string; factId: string; status: SemanticStatus; reasons: string[]; cached: boolean }
export interface ParaphraseInput { claim: string; fact: EvidenceFact }

export function cacheKey(tenant: string, fact: EvidenceFact, claim: string): string {
  const payload = [tenant, fact.source.contentHash, normalizeForQuote(claim), normalizeForQuote(fact.source.quote), normalizeForQuote(fact.source.context), String(VERIFIER_VERSION)].join('␟');
  return createHash('sha256').update(payload).digest('hex');
}

/** The deterministic checks. Returns the reasons the paraphrase fails, empty when it may go on to the judge. */
export function deterministicFailures(claim: string, fact: EvidenceFact): string[] {
  const failures: string[] = [];
  if (fact.status !== 'usable') failures.push(`the source fact is held for review (${fact.reasonCodes.join(', ') || 'needs_review'})`);
  if (fact.intent !== 'claim') failures.push(`the source states a ${fact.intent}, not a result`);
  if (fact.attribution !== 'brand') failures.push('the source is another party\'s statement');
  const claimed = extractFacts(claim);
  const quoted = extractFacts(fact.source.quote);
  for (const n of claimed.numbers) if (!quoted.numbers.includes(n)) failures.push(`the claim states ${n}, which the source does not`);
  for (const p of claimed.prices) if (!quoted.prices.includes(p)) failures.push(`the claim states the price ${p}, which the source does not`);
  for (const p of claimed.periods) if (!quoted.periods.includes(p)) failures.push(`the claim says "per ${p}", which the source does not`);
  for (const q of quoted.qualifiers) if (!claimed.qualifiers.includes(q)) failures.push(`the claim leaves out the qualifier "${q.split('|')[0]}" of the source`);
  return failures;
}

export async function verifyParaphrases(inputs: readonly ParaphraseInput[], judge: Judge, cache: VerdictCache, options: { tenant: string; batchSize?: number }): Promise<SemanticResult[]> {
  const batchSize = options.batchSize ?? 20;
  const results: SemanticResult[] = new Array<SemanticResult>(inputs.length);
  const pending: Array<{ index: number; item: JudgeItem }> = [];
  const asked = new Map<string, JudgeItem>();

  inputs.forEach((input, index) => {
    const failures = deterministicFailures(input.claim, input.fact);
    if (failures.length > 0) { results[index] = { claim: input.claim, factId: input.fact.id, status: 'rejected', reasons: failures, cached: false }; return; }
    const key = cacheKey(options.tenant, input.fact, input.claim);
    const known = cache.get(key);
    if (known !== undefined) { results[index] = fromAnswer(input, known, true); return; }
    const item: JudgeItem = { key, claim: input.claim, quote: input.fact.source.quote, context: input.fact.source.context };
    pending.push({ index, item });
    asked.set(key, item);
  });

  const items = [...asked.values()];
  const answers = new Map<string, JudgeAnswer>();
  let failed: string | null = null;
  for (let i = 0; i < items.length && failed === null; i += batchSize) {
    try {
      const verdicts = await judge(items.slice(i, i + batchSize));
      for (const v of verdicts) if (ANSWERS.includes(v.answer) && asked.has(v.key)) answers.set(v.key, v.answer);
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    }
  }
  for (const [key, answer] of answers) cache.set(key, answer);
  for (const { index, item } of pending) {
    const input = inputs[index] as ParaphraseInput;
    const answer = answers.get(item.key);
    results[index] = answer !== undefined ? fromAnswer(input, answer, false) : { claim: input.claim, factId: input.fact.id, status: 'uncertain', reasons: [failed !== null ? `the judge failed: ${failed}` : 'the judge gave no answer for this claim'], cached: false };
  }
  return results;
}

function fromAnswer(input: ParaphraseInput, answer: JudgeAnswer, cached: boolean): SemanticResult {
  const status: SemanticStatus = answer === 'supported' ? 'supported_by_model' : answer === 'unsupported' ? 'rejected' : 'uncertain';
  const reasons = answer === 'supported' ? ['a model judged the claim supported by the quote (semantic support is not verified by code)'] : answer === 'unsupported' ? ['a model judged the claim not supported by the quote'] : ['a model could not tell whether the quote supports the claim'];
  return { claim: input.claim, factId: input.fact.id, status, reasons, cached };
}

export interface CopySupportInput { copy: { headline: string; subline: string; caption: string }; facts: readonly EvidenceFact[] }
export interface CopySupportResult { status: SemanticStatus; reasons: string[]; cached: boolean }

/** Cache key of a post's copy against its facts. */
export function copyCacheKey(tenant: string, input: CopySupportInput): string {
  const claim = normalizeForQuote(`${input.copy.headline}\n${input.copy.subline}\n${input.copy.caption}`);
  const sources = input.facts.map((f) => `${f.source.contentHash}${normalizeForQuote(f.source.quote)}${normalizeForQuote(f.source.context)}`).join('␞');
  return createHash('sha256').update([tenant, claim, sources, String(VERIFIER_VERSION)].join('␟')).digest('hex');
}

/**
 * Asks the judge once for a batch of whole posts whether their copy says more than the facts they were written from say. Deterministic checks
 * (figures, qualifiers, attribution) are the claim gate's job and are not repeated here. A failing judge leaves every post uncertain.
 */
export async function verifyCopySupport(inputs: readonly CopySupportInput[], judge: Judge, cache: VerdictCache, options: { tenant: string; batchSize?: number }): Promise<CopySupportResult[]> {
  const batchSize = options.batchSize ?? 20;
  const results = new Array<CopySupportResult>(inputs.length);
  const asked = new Map<string, JudgeItem>();
  const keys = inputs.map((input) => copyCacheKey(options.tenant, input));
  inputs.forEach((input, index) => {
    const known = cache.get(keys[index] as string);
    if (known !== undefined) { results[index] = copyFromAnswer(known, true); return; }
    asked.set(keys[index] as string, { key: keys[index] as string, claim: `${input.copy.headline}\n${input.copy.subline}\n${input.copy.caption}`, quote: input.facts.map((f) => f.source.quote).join('\n'), context: input.facts.map((f) => f.source.context).join(' | ') });
  });
  const items = [...asked.values()];
  const answers = new Map<string, JudgeAnswer>();
  const why = new Map<string, string>();
  let failed: string | null = null;
  for (let i = 0; i < items.length && failed === null; i += batchSize) {
    try {
      for (const v of await judge(items.slice(i, i + batchSize))) if (ANSWERS.includes(v.answer) && asked.has(v.key)) { answers.set(v.key, v.answer); if (v.reason) why.set(v.key, v.reason); }
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    }
  }
  for (const [key, answer] of answers) cache.set(key, answer);
  inputs.forEach((_, index) => {
    if (results[index] !== undefined) return;
    const answer = answers.get(keys[index] as string);
    results[index] = answer !== undefined ? copyFromAnswer(answer, false, why.get(keys[index] as string)) : { status: 'uncertain', reasons: [failed !== null ? `the judge failed: ${failed}` : 'the judge gave no answer for this post'], cached: false };
  });
  return results;
}

function copyFromAnswer(answer: JudgeAnswer, cached: boolean, reason?: string): CopySupportResult {
  if (answer === 'supported') return { status: 'supported_by_model', reasons: ['a model judged the copy no stronger than its source facts (not verified by code)'], cached };
  if (answer === 'unsupported') return { status: 'rejected', reasons: [`a model judged the copy to claim more than its source facts say${reason ? `: ${reason}` : ''}`], cached };
  return { status: 'uncertain', reasons: ['a model could not tell whether the copy goes beyond its source facts'], cached };
}
