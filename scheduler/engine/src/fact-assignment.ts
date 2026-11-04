/**
 * Which evidence facts each post of a week may use. Code decides, not the model: facts rotate across weeks with a cooldown (a fact used
 * recently is ranked later, never banned, because a narrow brand may have only a few), a post gets one or two facts of different kinds, and
 * only facts that are usable and state a claim of the brand itself are ever offered.
 */
import { displayFact, type EvidenceFact } from './evidence.ts';

/** Facts a post may be written from: usable, the brand's own claim, one fact per wording and scope. */
export function offerableFacts(facts: readonly EvidenceFact[]): EvidenceFact[] {
  const seen = new Set<string>();
  const out: EvidenceFact[] = [];
  for (const fact of facts) {
    if (fact.status !== 'usable' || fact.intent !== 'claim' || fact.attribution !== 'brand') continue;
    const key = displayFact(fact).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
  }
  return out;
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

/**
 * Offerable facts, best first: those not used recently (the longer ago, the earlier), then those that say enough to build a post on
 * (a bare cell such as "2" is a weak start), then in the order the pages gave them.
 */
export function rankFacts(facts: readonly EvidenceFact[], recentFactIds: readonly string[]): EvidenceFact[] {
  const lastUsed = (id: string): number => recentFactIds.lastIndexOf(id);
  return [...facts].map((fact, index) => ({ fact, index })).sort((a, b) => {
    const [ua, ub] = [lastUsed(a.fact.id), lastUsed(b.fact.id)];
    if (ua !== ub) return ua - ub;
    const [ra, rb] = [words(displayFact(a.fact)) >= 4 ? 0 : 1, words(displayFact(b.fact)) >= 4 ? 0 : 1];
    return ra !== rb ? ra - rb : a.index - b.index;
  }).map((x) => x.fact);
}

export interface FactAssignmentInput {
  facts: readonly EvidenceFact[];
  /** One entry per post: the fact that must be the post's first, when a pillar fixed it. */
  anchors: ReadonlyArray<EvidenceFact | undefined>;
  recentFactIds: readonly string[];
  perPost?: number;
}

/** The facts of each post: its anchor or the best ranked fact not yet used this week, then a second fact of another category when one exists. */
export function assignFacts(input: FactAssignmentInput): EvidenceFact[][] {
  const perPost = Math.min(Math.max(input.perPost ?? 2, 1), 2);
  const ranked = rankFacts(input.facts, input.recentFactIds);
  const usedThisWeek = new Set<string>();
  return input.anchors.map((anchor) => {
    const fresh = ranked.filter((f) => !usedThisWeek.has(f.id));
    const pool = fresh.length > 0 ? fresh : ranked;
    const first = anchor ?? pool[0];
    if (first === undefined) return [];
    const chosen = [first];
    if (perPost > 1) {
      const second = pool.find((f) => f.id !== first.id && f.category !== first.category);
      if (second) chosen.push(second);
    }
    for (const fact of chosen) usedThisWeek.add(fact.id);
    return chosen;
  });
}
