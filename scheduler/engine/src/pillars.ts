/**
 * Content pillars: the kinds of post a brand publishes (a need it meets, something it explains, proof, an offer, how it works), and the mix
 * of them across a week. Code decides which pillar each post belongs to, so a week is varied whatever the model writes, and a pillar is offered
 * only when the evidence for it exists. A post that states something about the business (education, proof) is built on one verified proof
 * point and checked against it. The pillar set, its evidence needs and its weights are settings.
 */
import { extractFacts, normalizeForQuote, verifyClaim } from './claims.ts';
import { withDigits } from './copy-gate.ts';

export interface PillarSpec {
  name: string;
  /** What the post must do, given to the writer. */
  brief: string;
  /** The evidence the pillar needs from the brand profile before it may be used. */
  needs: 'proof' | 'offer' | 'identity' | null;
  /** How often it comes up compared with the others (1 when omitted); 0 switches it off. */
  weight?: number;
}

export const defaultPillars: readonly PillarSpec[] = [
  { name: 'problem', brief: 'Describe a need or situation the audience has that the brand\'s offer meets, using only what the profile says the brand offers.', needs: 'offer' },
  { name: 'education', brief: 'Explain one concept, feature or process taken from the verified proof point given for it, in plain words. Add no outside facts, figures or advice.', needs: 'proof' },
  { name: 'proof', brief: 'Build the post on the one verified proof point given for it, stated with its figures and wording unchanged.', needs: 'proof' },
  { name: 'offer', brief: 'Present what the brand offers, as the profile states it, and the one action to take.', needs: 'offer' },
  { name: 'story', brief: 'Show how the brand works or what it stands for, in plain words from its identity line and profile. No invented history, names or customers.', needs: 'identity' },
];

export interface PostAssignment {
  pillar: string;
  brief: string;
  /** For a post that rests on evidence: the verified proof point it is built on. */
  anchor?: string;
}

export interface PillarEvidence {
  proofPoints: readonly string[];
  offer: string;
  /** The brand's identity record; a name-only identity is no evidence of what the brand is. */
  identity?: { kind: string };
}

/** The pillars the brand's evidence allows, in the order of the set. */
export function availablePillars(brand: PillarEvidence, pillars: readonly PillarSpec[] = defaultPillars): string[] {
  const has = { proof: brand.proofPoints.length > 0, offer: brand.offer.trim().length > 0, identity: brand.identity !== undefined && brand.identity.kind !== 'name-only' };
  return pillars.filter((p) => (p.weight ?? 1) > 0 && (p.needs === null || has[p.needs])).map((p) => p.name);
}

/**
 * The pillar of each post of a week. Each slot takes the pillar furthest below its share this week (uses divided by weight), then below its
 * share in recent weeks, then the one unused for longest, and never the one just before it, so a week is balanced and the next week carries
 * on where the last stopped.
 */
export function pillarsForWeek(input: { count: number; available: readonly string[]; recent: readonly string[]; weights?: Readonly<Record<string, number>> }): string[] {
  const { count, available, recent } = input;
  if (available.length === 0) throw new Error('no pillar is available for this brand: it has no offer, proof point or identity to build a post on');
  const weightOf = (name: string): number => input.weights?.[name] ?? 1;
  const window = recent.slice(-available.length * 2);
  const week: string[] = [];
  for (let slot = 0; slot < count; slot++) {
    const history = [...recent, ...week];
    const previous = history.at(-1);
    const candidates = available.length > 1 ? available.filter((name) => name !== previous) : [...available];
    const key = (name: string): [number, number, number, number] => {
      const lastUsed = history.lastIndexOf(name);
      return [week.filter((w) => w === name).length / weightOf(name), window.filter((w) => w === name).length / weightOf(name), lastUsed === -1 ? -Infinity : lastUsed - history.length, available.indexOf(name)];
    };
    const best = [...candidates].sort((a, b) => {
      const [ka, kb] = [key(a), key(b)];
      for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
      return 0;
    })[0];
    week.push(best as string);
  }
  return week;
}

/** The pillar, brief and (for evidence-based posts) proof point of every post of a week. */
export function assignWeek(input: {
  brand: PillarEvidence;
  count: number;
  recent: readonly string[];
  /** How many evidence-based posts were written before, so the proof points rotate across weeks. */
  recentAnchoredCount: number;
  pillars?: readonly PillarSpec[];
}): PostAssignment[] {
  const specs = input.pillars ?? defaultPillars;
  const weights = Object.fromEntries(specs.map((p) => [p.name, p.weight ?? 1]));
  const sequence = pillarsForWeek({ count: input.count, available: availablePillars(input.brand, specs), recent: input.recent, weights });
  let anchorIndex = input.recentAnchoredCount;
  return sequence.map((name) => {
    const spec = specs.find((p) => p.name === name) as PillarSpec;
    if (spec.needs !== 'proof') return { pillar: name, brief: spec.brief };
    const anchor = input.brand.proofPoints[anchorIndex % input.brand.proofPoints.length] as string;
    anchorIndex += 1;
    return { pillar: name, brief: spec.brief, anchor };
  });
}

const stems = (text: string, min: number): string[] => normalizeForQuote(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= min).map((w) => w.slice(0, 5));
const sentencesOf = (text: string): string[] => text.replaceAll('|', '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/**
 * Why a post is not built on its proof point, or undefined when it is. Shared wording is necessary but never enough: every sentence that
 * touches the point is checked against it for numbers, prices, units, billing periods, qualifiers and negation (so "guarantees" cannot pass for
 * "does not guarantee"), and a faithful paraphrase passes when it keeps the point's figures even if the words differ.
 */
export function checkAnchored(copy: { headline: string; subline: string; caption: string }, point: string, share = 0.6): string | undefined {
  let wanted = stems(point, 5);
  if (wanted.length === 0) wanted = stems(point, 3);
  const sentences = [copy.headline, copy.subline, ...sentencesOf(copy.caption)].flatMap(sentencesOf);
  const wantedSet = new Set(wanted);
  const related = sentences.filter((s) => stems(s, 3).some((w) => wantedSet.has(w)));
  const pages = [{ url: 'proof:point', text: point, fetchedAt: new Date().toISOString() }];
  const verdicts = related.map((sentence) => ({ sentence, result: verifyClaim({ text: sentence, sourceUrl: 'proof:point', quote: point }, pages, { now: new Date(), config: { minWordOverlap: 0 } }) }));
  const changed = verdicts.find((v) => v.result.verification.status === 'rejected');
  if (changed) return `the sentence "${changed.sentence.slice(0, 60)}" changes the proof point (${changed.result.verification.reasons.join('; ')})`;
  const have = new Set(stems(`${copy.headline} ${copy.subline} ${copy.caption}`.replaceAll('|', ''), 3));
  const covered = wanted.length === 0 || wanted.filter((w) => have.has(w)).length / wanted.length >= share;
  const facts = extractFacts(withDigits(point));
  const hasFigures = facts.numbers.length > 0 || facts.prices.length > 0;
  if (covered || (hasFigures && verdicts.some((v) => v.result.verification.status === 'verified'))) return undefined;
  return 'its words and figures are not in the copy';
}

/** True when the copy is built on the proof point. */
export function anchoredTo(copy: { headline: string; subline: string; caption: string }, point: string, share = 0.6): boolean {
  return checkAnchored(copy, point, share) === undefined;
}
