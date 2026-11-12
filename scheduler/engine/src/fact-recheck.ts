/**
 * The facts a post rests on are looked at again when its picture is drawn, not only when its words were written: a month's plan is written at once and its last
 * weeks are drawn weeks later, and a price or an offer can go stale, or the customer can take a fact out, in between. A post that rests on a fact that is no
 * longer usable (a commercial term older than the limit, or a fact she removed) is not drawn: it is left open for her (NotDrawn FACT_OUT_OF_DATE).
 *
 * Only what has become worse is checked. A fact she has not confirmed is still fine (it was usable when the words were written), so choosing "approved only"
 * later never turns an unconfirmed fact into a reason not to draw.
 */
import type { EvidenceFact } from './evidence.ts';
import type { ReviewFile } from './fact-review.ts';

/** A price or an offer older than this at the time of the draw is stale (the writing rule is 30 days; a plan is drawn up to about a month later). */
export const DRAW_FACT_MAX_AGE_DAYS = 45;

/** The ids of the facts that are still fine to draw from: usable now (fresh enough) and not removed by her. */
export function drawableFactIds(facts: readonly EvidenceFact[], review: ReviewFile | null): Set<string> {
  const removed = new Set(Object.entries(review?.decisions ?? {}).filter(([, d]) => d.decision === 'rejected').map(([id]) => id));
  return new Set(facts.filter((f) => f.status === 'usable' && !removed.has(f.id)).map((f) => f.id));
}

/** The posts that rest on a fact that is no longer drawable. A post with no facts recorded (an older batch) is not judged. */
export function postsWithOutdatedFacts(posts: ReadonlyArray<{ id: string; factIds?: readonly string[] }>, drawable: ReadonlySet<string>): string[] {
  return posts.filter((p) => (p.factIds ?? []).some((id) => !drawable.has(id))).map((p) => p.id);
}
