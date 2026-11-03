/**
 * Content pillars: the kinds of post a brand publishes (a pain it removes, something it teaches, proof, an offer, how it works), and the mix
 * of them across a week. Code decides which pillar each post belongs to, so a week is varied whatever the model writes, and a pillar is offered
 * only when the evidence for it exists (no proof post without a verified proof point). The set of pillars is a setting.
 */

export interface PillarSpec {
  name: string;
  /** What the post must do, given to the writer. */
  brief: string;
  /** The evidence the pillar needs from the brand profile before it may be used. */
  needs: 'proof' | 'offer' | null;
}

export const defaultPillars: readonly PillarSpec[] = [
  { name: 'problem', brief: 'Name a pain the audience recognises from their own day and show how the brand removes it.', needs: null },
  { name: 'education', brief: 'Teach one useful, true thing about the subject the brand works in. No sales pitch: the brand appears as the helpful source.', needs: null },
  { name: 'proof', brief: 'Build the post on the one verified proof point given for it, stated with its figures and wording unchanged.', needs: 'proof' },
  { name: 'offer', brief: 'Present what the brand offers, as the profile states it, and the one action to take.', needs: 'offer' },
  { name: 'story', brief: 'Show how the brand works or what it stands for, in plain words from the profile. No invented history, names or customers.', needs: null },
];

export interface PostAssignment {
  pillar: string;
  brief: string;
  /** For a proof post: the verified proof point it is built on. */
  anchor?: string;
}

/** The pillars the brand's evidence allows, in the order of the set. */
export function availablePillars(brand: { proofPoints: readonly string[]; offer: string }, pillars: readonly PillarSpec[] = defaultPillars): string[] {
  return pillars
    .filter((p) => (p.needs === 'proof' ? brand.proofPoints.length > 0 : p.needs === 'offer' ? brand.offer.trim().length > 0 : true))
    .map((p) => p.name);
}

/**
 * The pillar of each post of a week. Each slot takes the pillar used least so far this week, then the one used least in recent weeks, then
 * the one unused for longest, and never the one just before it, so a week is balanced and the next week carries on where the last stopped.
 */
export function pillarsForWeek(input: { count: number; available: readonly string[]; recent: readonly string[] }): string[] {
  const { count, available, recent } = input;
  if (available.length === 0) throw new Error('no pillar is available for this brand');
  const window = recent.slice(-available.length * 2);
  const week: string[] = [];
  for (let slot = 0; slot < count; slot++) {
    const history = [...recent, ...week];
    const previous = history.at(-1);
    const candidates = available.length > 1 ? available.filter((name) => name !== previous) : [...available];
    const key = (name: string): [number, number, number, number] => {
      const lastUsed = history.lastIndexOf(name);
      return [week.filter((w) => w === name).length, window.filter((w) => w === name).length, lastUsed === -1 ? -Infinity : lastUsed - history.length, available.indexOf(name)];
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

/** The pillar, brief and (for proof posts) proof point of every post of a week. */
export function assignWeek(input: {
  brand: { proofPoints: readonly string[]; offer: string };
  count: number;
  recent: readonly string[];
  /** How many proof posts were written before, so the proof points rotate across weeks. */
  recentProofCount: number;
  pillars?: readonly PillarSpec[];
}): PostAssignment[] {
  const specs = input.pillars ?? defaultPillars;
  const sequence = pillarsForWeek({ count: input.count, available: availablePillars(input.brand, specs), recent: input.recent });
  let proofIndex = input.recentProofCount;
  return sequence.map((name) => {
    const spec = specs.find((p) => p.name === name) as PillarSpec;
    if (spec.needs !== 'proof') return { pillar: name, brief: spec.brief };
    const anchor = input.brand.proofPoints[proofIndex % input.brand.proofPoints.length] as string;
    proofIndex += 1;
    return { pillar: name, brief: spec.brief, anchor };
  });
}

const stems = (text: string, min: number): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= min).map((w) => w.slice(0, 5));

/** True when the copy is built on the proof point: most of the point's main words (as the same word or one sharing its first five letters) appear in it. */
export function anchoredTo(copy: { headline: string; subline: string; caption: string }, point: string, share = 0.6): boolean {
  let wanted = stems(point, 5);
  if (wanted.length === 0) wanted = stems(point, 3);
  if (wanted.length === 0) return true;
  const have = new Set(stems(`${copy.headline.replaceAll('|', '')} ${copy.subline} ${copy.caption}`, 3));
  return wanted.filter((w) => have.has(w)).length / wanted.length >= share;
}
