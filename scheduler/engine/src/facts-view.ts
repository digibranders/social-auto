/**
 * The facts the engine found on a site, for the owner to look at before posts are written, and the three things the owner can do with one: remove it (no post is
 * written from it), confirm it, or put it back. Held facts (proof claims such as statistics, awards or certifications, see proof-hold.ts) are shown with the reason
 * they are held and cannot be confirmed. Confirming even one fact switches the brand to "confirmed facts only": see `mode`.
 */
import { isCustomerFact } from './customer-facts.ts';
import { join } from 'node:path';
import { loadFacts } from './evidence-pipeline.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';
import { acquireLock, LockError } from './file-lock.ts';
import { emptyReview, loadReview, REVIEW_FILE, saveReview } from './fact-review.ts';
import { readJson } from './content.ts';

export class FactsError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID' | 'HELD' | 'LOCKED';
  constructor(code: FactsError['code'], message: string) {
    super(message);
    this.name = 'FactsError';
    this.code = code;
  }
}

export type FactState = 'suggested' | 'confirmed' | 'removed';
export interface FactView { factId: string; text: string; sourceUrl: string; sourceQuote: string; state: FactState; held: boolean; heldReason?: string }
export interface FactsResponse {
  brand: string;
  builtAt: string;
  /** "all_usable": every fact not removed is used. "approved_only": only confirmed facts are used (as soon as one is confirmed). */
  mode: 'all_usable' | 'approved_only';
  profile: { name: string; website: string; tone: string; audience: string; offer: string };
  facts: FactView[];
  counts: { suggested: number; confirmed: number; removed: number; held: number };
}

const MAX_FACTS = 80;
export const FACT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,80}$/;

const shown = (f: EvidenceFact): boolean => !isCustomerFact(f) && f.intent === 'claim' && f.attribution === 'brand' && (f.status === 'usable' || f.proofHold !== undefined);

export async function factsView(brandDir: string, brand: string): Promise<FactsResponse> {
  const loaded = await loadFacts(brandDir);
  if (!loaded) throw new FactsError('NOT_FOUND', 'no facts have been read for this brand yet');
  const review = await loadReview(brandDir);
  const decisions = review?.decisions ?? {};
  const seen = new Set<string>();
  const facts: FactView[] = [];
  for (const f of loaded.facts.filter(shown)) {
    const key = displayFact(f).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const decided = decisions[f.id]?.decision;
    facts.push({ factId: f.id, text: displayFact(f), sourceUrl: f.source.url, sourceQuote: f.source.quote, state: decided === 'approved' ? 'confirmed' : decided === 'rejected' ? 'removed' : 'suggested', held: f.proofHold !== undefined, ...(f.proofHold ? { heldReason: f.proofHold.reason } : {}) });
    if (facts.length >= MAX_FACTS) break;
  }
  // Only the profile lines the owner reads; the full profile has far more than a screen of facts needs, and a damaged field there must not hide the facts.
  const raw = (await readJson(join(brandDir, 'brand.json')).catch(() => ({}))) as Record<string, unknown>;
  const line = (key: string): string => (typeof raw[key] === 'string' ? (raw[key] as string) : '');
  const count = (state: FactState): number => facts.filter((f) => f.state === state).length;
  return {
    brand, builtAt: loaded.file.builtAt, mode: Object.values(decisions).some((d) => d.decision === 'approved') ? 'approved_only' : 'all_usable',
    profile: { name: line('name'), website: line('website'), tone: line('tone'), audience: line('audience'), offer: line('offer') },
    facts, counts: { suggested: count('suggested'), confirmed: count('confirmed'), removed: count('removed'), held: facts.filter((f) => f.held).length },
  };
}

/** One change to the owner's decisions about a fact, under a lock so two requests cannot overwrite each other. */
export async function decideFact(brandDir: string, factId: string, action: 'confirm' | 'remove' | 'restore', now: Date = new Date()): Promise<void> {
  if (!FACT_ID.test(factId)) throw new FactsError('INVALID', 'that is not a fact id');
  const loaded = await loadFacts(brandDir);
  const fact = loaded?.facts.find((f) => f.id === factId && shown(f));
  if (!fact) throw new FactsError('NOT_FOUND', 'no such fact for this brand');
  if (action === 'confirm' && fact.proofHold) throw new FactsError('HELD', `this fact is held back from the automatic flow: ${fact.proofHold.reason}`);
  let release: () => void;
  try {
    release = acquireLock(join(brandDir, `${REVIEW_FILE}.lock`), { timeoutMs: 5000 });
  } catch (error) {
    if (error instanceof LockError) throw new FactsError('LOCKED', 'the facts are busy, so nothing was changed');
    throw error;
  }
  try {
    const review = (await loadReview(brandDir)) ?? emptyReview();
    const decisions = { ...review.decisions };
    if (action === 'restore') delete decisions[factId];
    else decisions[factId] = { decision: action === 'confirm' ? 'approved' : 'rejected', text: displayFact(fact), decidedAt: now.toISOString() };
    await saveReview(brandDir, { version: 1, decisions });
  } finally {
    release();
  }
}
