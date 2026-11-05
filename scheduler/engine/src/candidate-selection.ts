/**
 * More copy than posters: the planner writes up to twice as many source-backed candidates as posts are asked for, each from a DIFFERENT verified
 * fact, lets them pass every check before any picture is bought, and keeps the best ones. Candidates that did not make the cut are not wasted
 * (they are kept as reserve drafts), and none is ever made up to fill a slot: with fewer eligible facts there are fewer candidates and fewer posts.
 *
 * Choosing is done in code, reproducibly: score = 0.55 x the fact's worth + 0.35 x novelty against recent posts + 0.10 x headline length, then a
 * greedy pick that never takes the same fact twice, never takes a proposition that repeats one already chosen, and prefers the more different of
 * two near-equal candidates.
 */
import { defaultSimilarityConfig, wordOverlap } from './concept-similarity.ts';

/** How many candidates to write for `requested` posts: twice as many, never more than the eligible distinct facts, at most `cap`. */
export function candidateCount(requested: number, eligibleDistinctFacts: number, options: { factor?: number; cap?: number } = {}): number {
  const factor = options.factor ?? 2;
  const cap = options.cap ?? 8;
  if (requested <= 0 || eligibleDistinctFacts <= 0) return 0;
  return Math.max(0, Math.min(Math.ceil(requested * factor), eligibleDistinctFacts, Math.max(cap, requested)));
}

export interface Candidate {
  id: string;
  /** The fact the candidate is built on; one candidate per fact. */
  factId: string;
  headline: string;
  /** What the post is about, one sentence; compared with other candidates to catch a repeated proposition. */
  proposition: string;
  /** The fact's poster-worthiness total, 0 to 6; absent when it was not judged. */
  worth?: number;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const wordsIn = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/** 1 for a headline of 4 to 12 words, 0.5 for 13 to 16, otherwise 0. A ranking preference only: a qualification is never cut to shorten a headline. */
export function headlineLengthScore(headline: string): number {
  const n = wordsIn(headline.replace(/\|/g, ''));
  return n >= 4 && n <= 12 ? 1 : n >= 13 && n <= 16 ? 0.5 : 0;
}

/** 1 minus the largest word overlap with any recent headline or proposition: 1 is wholly new, 0 repeats one. */
export function noveltyScore(candidate: Pick<Candidate, 'headline' | 'proposition'>, recent: readonly string[]): number {
  const text = `${candidate.headline} ${candidate.proposition}`;
  let max = 0;
  for (const past of recent) max = Math.max(max, wordOverlap(text, past, defaultSimilarityConfig));
  return clamp01(1 - max);
}

export const SCORE_WEIGHTS = { worth: 0.55, novelty: 0.35, length: 0.1 } as const;

export function scoreCandidate(candidate: Candidate, recent: readonly string[]): number {
  const worth = candidate.worth === undefined ? 0.5 : clamp01(candidate.worth / 6);
  return SCORE_WEIGHTS.worth * worth + SCORE_WEIGHTS.novelty * noveltyScore(candidate, recent) + SCORE_WEIGHTS.length * headlineLengthScore(candidate.headline);
}

export interface Selection {
  selected: Candidate[];
  /** Validated candidates that were not chosen, best first: the reserve. */
  reserve: Candidate[];
  /** Candidates left out because of a rule, not only a lower score. */
  skipped: Array<{ id: string; reason: string }>;
  scores: Record<string, number>;
}

/** Two propositions this alike are one proposition. */
export const DUPLICATE_PROPOSITION = 0.6;
/** Candidates whose scores are within this of the best remaining are "near-equal" and the more different one is preferred. */
export const NEAR_EQUAL = 0.02;

export function selectBest(candidates: readonly Candidate[], count: number, options: { recent?: readonly string[] } = {}): Selection {
  const recent = options.recent ?? [];
  const scores: Record<string, number> = {};
  for (const c of candidates) scores[c.id] = scoreCandidate(c, recent);
  // Reproducible: by score, then by fact id, then by id.
  const remaining = [...candidates].sort((a, b) => (scores[b.id] as number) - (scores[a.id] as number) || a.factId.localeCompare(b.factId) || a.id.localeCompare(b.id));
  const selected: Candidate[] = [];
  const skipped: Selection['skipped'] = [];
  const overlapWithChosen = (c: Candidate): number => selected.reduce((max, s) => Math.max(max, wordOverlap(`${c.headline} ${c.proposition}`, `${s.headline} ${s.proposition}`, defaultSimilarityConfig)), 0);
  while (selected.length < count && remaining.length > 0) {
    // Candidates that break a rule are set aside first.
    for (let i = remaining.length - 1; i >= 0; i--) {
      const c = remaining[i] as Candidate;
      if (selected.some((s) => s.factId === c.factId)) { skipped.push({ id: c.id, reason: 'the same fact as a post already chosen' }); remaining.splice(i, 1); }
      else if (overlapWithChosen(c) >= DUPLICATE_PROPOSITION) { skipped.push({ id: c.id, reason: 'it says what a post already chosen says' }); remaining.splice(i, 1); }
    }
    if (remaining.length === 0) break;
    const top = scores[(remaining[0] as Candidate).id] as number;
    const near = remaining.filter((c) => top - (scores[c.id] as number) <= NEAR_EQUAL);
    // Of the near-equal candidates, the one most different from what is already chosen (the first in the order when none is chosen yet).
    const pick = selected.length === 0 ? (near[0] as Candidate) : near.reduce((best, c) => (overlapWithChosen(c) < overlapWithChosen(best) ? c : best), near[0] as Candidate);
    selected.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return { selected, reserve: remaining, skipped, scores };
}
