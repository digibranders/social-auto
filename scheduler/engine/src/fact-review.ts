/**
 * The owner's say over which facts a brand's posts may be written from. A shortlist of the best-ranked candidates is shown with its ids; the
 * owner approves or rejects. Once anything is approved, only approved facts are used (and a rejected one never is); with no decisions, every
 * usable fact is eligible, as before. Decisions are kept per brand in `facts-review.json`, keyed by fact id (a hash of source, scope and
 * wording, so a fact that changed on the site is no longer approved). Nothing here is specific to a brand or an industry.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './art-pipeline.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';
import { offerableFacts, rankFacts } from './fact-assignment.ts';

export const REVIEW_FILE = 'facts-review.json';
export type Decision = 'approved' | 'rejected';
export interface ReviewFile { version: 1; decisions: Record<string, { decision: Decision; text: string; decidedAt: string }> }

export const emptyReview = (): ReviewFile => ({ version: 1, decisions: {} });

/** The best-ranked offerable facts, one per wording, to put in front of the owner. */
export function shortlist(facts: readonly EvidenceFact[], recentFactIds: readonly string[] = [], limit = 25): EvidenceFact[] {
  return rankFacts(offerableFacts(facts), recentFactIds).slice(0, limit);
}

export interface ReviewedFacts { facts: EvidenceFact[]; mode: 'all_usable' | 'approved_only'; approved: number; rejected: number }

export function applyReview(facts: readonly EvidenceFact[], review: ReviewFile | null): ReviewedFacts {
  const decisions = review?.decisions ?? {};
  const approvedIds = new Set(Object.entries(decisions).filter(([, d]) => d.decision === 'approved').map(([id]) => id));
  const rejectedIds = new Set(Object.entries(decisions).filter(([, d]) => d.decision === 'rejected').map(([id]) => id));
  const notRejected = facts.filter((f) => !rejectedIds.has(f.id));
  if (approvedIds.size === 0) return { facts: notRejected, mode: 'all_usable', approved: 0, rejected: rejectedIds.size };
  return { facts: notRejected.filter((f) => approvedIds.has(f.id)), mode: 'approved_only', approved: approvedIds.size, rejected: rejectedIds.size };
}

/** Records a decision for facts named by id or by a unique id prefix. Unknown or ambiguous names are an error and nothing is recorded. */
export function decide(review: ReviewFile, facts: readonly EvidenceFact[], names: readonly string[], decision: Decision, now: Date): ReviewFile {
  const chosen: EvidenceFact[] = [];
  for (const name of names) {
    const hits = facts.filter((f) => f.id === name || (name.length >= 4 && f.id.startsWith(name)));
    if (hits.length === 0) throw new Error(`no fact has the id "${name}"`);
    const exact = hits.find((f) => f.id === name);
    if (hits.length > 1 && !exact) throw new Error(`"${name}" matches ${hits.length} facts; give more of the id`);
    chosen.push(exact ?? (hits[0] as EvidenceFact));
  }
  const decisions = { ...review.decisions };
  for (const fact of chosen) decisions[fact.id] = { decision, text: displayFact(fact), decidedAt: now.toISOString() };
  return { version: 1, decisions };
}

export async function loadReview(brandDir: string): Promise<ReviewFile | null> {
  let text: string;
  try {
    text = await readFile(join(brandDir, REVIEW_FILE), 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${join(brandDir, REVIEW_FILE)} is not valid JSON; fix or remove it`);
  }
  const record = raw as { version?: unknown; decisions?: unknown };
  if (record.version !== 1 || typeof record.decisions !== 'object' || record.decisions === null || Array.isArray(record.decisions)) throw new Error(`${join(brandDir, REVIEW_FILE)} has the wrong shape; fix or remove it`);
  for (const value of Object.values(record.decisions)) {
    const d = value as { decision?: unknown; text?: unknown };
    if ((d.decision !== 'approved' && d.decision !== 'rejected') || typeof d.text !== 'string') throw new Error(`${join(brandDir, REVIEW_FILE)} has a malformed decision; fix or remove it`);
  }
  return raw as ReviewFile;
}

export async function saveReview(brandDir: string, review: ReviewFile): Promise<void> {
  await mkdir(brandDir, { recursive: true });
  await writeFileAtomic(join(brandDir, REVIEW_FILE), `${JSON.stringify(review, null, 2)}\n`);
}
