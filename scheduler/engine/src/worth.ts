/**
 * Poster-worthiness of an evidence fact: whether a stranger scrolling a feed would care about it as a message on its own. Three scores of 0 to 2
 * (what a reader can do or get from it, whether it stands alone without jargon or context, and whether it says something specific), judged in one
 * batched request for the best candidates and kept per fact so a fact is judged once. The total decides which facts may be a post's one message:
 * 5 or 6 are preferred, 3 or 4 are allowed, 2 or less are held back as supporting detail. The thresholds are provisional and meant to be calibrated against
 * the owner's approvals. This says nothing about whether a fact is true: that is the evidence layer's job.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './art-pipeline.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';

export const WORTH_FILE = 'facts-worth.json';
export const WORTH_VERSION = 1;
/** A fact needs at least this total to be a post's one message. */
export const MIN_WORTH = 3;

export interface WorthScore { relevance: number; clarity: number; value: number; total: number }
export interface WorthFile { version: number; scores: Record<string, WorthScore> }
export interface WorthItem { key: string; text: string; context: string }
export interface WorthVerdict { key: string; relevance: number; clarity: number; value: number }
export type WorthJudge = (items: WorthItem[]) => Promise<WorthVerdict[]>;

const clamp = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(2, Math.round(n))) : 0);

/** The total that counts for ranking: a fact with a zero in any dimension cannot be a post on its own, so its total is capped at the supporting level. */
export function effectiveTotal(score: WorthScore): number {
  return score.relevance === 0 || score.clarity === 0 || score.value === 0 ? Math.min(score.total, MIN_WORTH - 1) : score.total;
}

export function toScore(v: Pick<WorthVerdict, 'relevance' | 'clarity' | 'value'>): WorthScore {
  const [relevance, clarity, value] = [clamp(v.relevance), clamp(v.clarity), clamp(v.value)];
  return { relevance, clarity, value, total: relevance + clarity + value };
}

/** Judges the facts that have no score yet, in batches, and returns every known score. A judge that fails scores nothing: unscored facts are not held back. */
export async function scoreFacts(facts: readonly EvidenceFact[], known: Readonly<Record<string, WorthScore>>, judge: WorthJudge, options: { batchSize?: number } = {}): Promise<{ scores: Record<string, WorthScore>; judged: number; failure?: string }> {
  const scores: Record<string, WorthScore> = { ...known };
  const missing = facts.filter((f) => scores[f.id] === undefined);
  const size = options.batchSize ?? 20;
  let judged = 0;
  for (let i = 0; i < missing.length; i += size) {
    const batch = missing.slice(i, i + size);
    try {
      const verdicts = await judge(batch.map((f) => ({ key: f.id, text: displayFact(f), context: f.source.context })));
      for (const v of verdicts) if (batch.some((f) => f.id === v.key)) { scores[v.key] = toScore(v); judged += 1; }
    } catch (error) {
      return { scores, judged, failure: error instanceof Error ? error.message : String(error) };
    }
  }
  return { scores, judged };
}

export async function loadWorth(brandDir: string): Promise<WorthFile> {
  try {
    const raw = JSON.parse(await readFile(join(brandDir, WORTH_FILE), 'utf8')) as Partial<WorthFile>;
    if (raw.version === WORTH_VERSION && typeof raw.scores === 'object' && raw.scores !== null) return { version: WORTH_VERSION, scores: raw.scores };
  } catch {
    // no scores yet, or an unreadable file: start again, the cost is one batched request
  }
  return { version: WORTH_VERSION, scores: {} };
}

export async function saveWorth(brandDir: string, file: WorthFile): Promise<void> {
  await mkdir(dirname(join(brandDir, WORTH_FILE)), { recursive: true });
  await writeFileAtomic(join(brandDir, WORTH_FILE), `${JSON.stringify(file, null, 2)}\n`);
}
