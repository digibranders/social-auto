/**
 * How alike two visual concepts are, measured in code so that a near-duplicate is caught before any picture is bought. There is no list of styles or scenes
 * here: a concept is free text, and two concepts are compared by the words that carry their meaning (the generic words of art direction and the words every
 * poster of the brand shares are left out) and, when an embedding is available, by meaning. A flagged pair is only a flag: whether the two really show the
 * same idea is decided by a focused comparison (see creative-director.ts), because two different pictures can be close in meaning when they explain the same fact.
 */

export interface SimilarityConfig {
  /** Share of meaningful words two concepts may have in common (Jaccard). At or above this the pair is flagged. */
  maxWordOverlap: number;
  /** Cosine similarity of two embeddings at or above which the pair is flagged. */
  maxEmbeddingSimilarity: number;
  /** Words that say nothing about what is pictured ("modern", "professional", "composition"). */
  genericWords: readonly string[];
}

export const defaultSimilarityConfig: SimilarityConfig = {
  maxWordOverlap: 0.45,
  maxEmbeddingSimilarity: 0.88,
  genericWords: [
    'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto', 'over', 'under', 'its', 'their', 'his', 'her', 'is', 'are', 'was', 'be', 'as', 'that', 'this', 'it', 'one', 'two', 'three', 'each', 'every', 'while', 'where', 'which', 'who', 'no', 'not', 'only', 'but', 'than', 'then', 'there', 'one', 'single',
    'modern', 'premium', 'professional', 'clean', 'minimal', 'minimalist', 'simple', 'bold', 'beautiful', 'stunning', 'creative', 'original', 'unique', 'visual', 'image', 'poster', 'picture', 'scene', 'concept', 'idea', 'design', 'designed', 'style', 'styled', 'composition', 'composed', 'frame', 'background', 'foreground', 'centre', 'center', 'left', 'right', 'top', 'bottom', 'side', 'brand', 'brands', 'color', 'colour', 'colors', 'colours', 'palette', 'accent', 'detail', 'small', 'large', 'tiny', 'big', 'soft', 'warm', 'cool', 'light', 'lighting', 'mood', 'atmosphere', 'feel', 'feeling', 'sense', 'show', 'shows', 'showing', 'shown', 'depicts', 'depicting', 'features', 'featuring', 'communicates', 'communicating', 'different', 'differs', 'unlike', 'instead', 'rather', 'whereas', 'other', 'others', 'posters', 'compared',
  ],
};

const normal = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stem = (word: string): string => word.replace(/ies$/, 'y').replace(/(?:ing|ed|es|s)$/, '');

/** The words of a concept that say what is pictured, as stems. `shared` are words every poster of this brand or batch has to use (the brand and product names). */
export function meaningfulWords(concept: string, config: SimilarityConfig = defaultSimilarityConfig, shared: readonly string[] = []): Set<string> {
  const skip = new Set([...config.genericWords, ...shared].map((w) => stem(normal(w))));
  return new Set(normal(concept).split(' ').filter((w) => w.length > 2 && !skip.has(w) && !skip.has(stem(w))).map(stem).filter((w) => w.length > 2 && !skip.has(w)));
}

/** Jaccard overlap of the meaningful words of two concepts, 0 to 1. */
export function wordOverlap(a: string, b: string, config: SimilarityConfig = defaultSimilarityConfig, shared: readonly string[] = []): number {
  const x = meaningfulWords(a, config, shared);
  const y = meaningfulWords(b, config, shared);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const w of x) if (y.has(w)) common += 1;
  return common / (x.size + y.size - common);
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface ConceptRef {
  /** The post it belongs to, or a label for a concept from an earlier week. */
  id: string;
  concept: string;
  /** True for a concept from the brand's history, which a new concept must also differ from. */
  past?: boolean;
}

export interface FlaggedPair {
  a: string;
  b: string;
  /** Why it was flagged: "identical", "word overlap 0.52" or "embedding 0.91". */
  reason: string;
  overlap: number;
  similarity: number | null;
}

/**
 * Every pair of concepts to be looked at again: the new concepts against each other and against the brand's recent history. Past concepts are never
 * compared with each other. `embeddings` (by id) are optional; without them only the words are compared.
 */
export function flagSimilar(concepts: readonly ConceptRef[], options: { config?: SimilarityConfig; shared?: readonly string[]; embeddings?: ReadonlyMap<string, readonly number[]> } = {}): FlaggedPair[] {
  const config = options.config ?? defaultSimilarityConfig;
  const flagged: FlaggedPair[] = [];
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i] as ConceptRef;
      const b = concepts[j] as ConceptRef;
      if (a.past && b.past) continue;
      const overlap = wordOverlap(a.concept, b.concept, config, options.shared);
      const ea = options.embeddings?.get(a.id);
      const eb = options.embeddings?.get(b.id);
      const similarity = ea && eb ? cosine(ea, eb) : null;
      const reason = normal(a.concept) === normal(b.concept) ? 'identical' : overlap >= config.maxWordOverlap ? `word overlap ${overlap.toFixed(2)}` : similarity !== null && similarity >= config.maxEmbeddingSimilarity ? `embedding ${similarity.toFixed(2)}` : null;
      if (reason !== null) flagged.push({ a: a.id, b: b.id, reason, overlap, similarity });
    }
  }
  return flagged;
}
