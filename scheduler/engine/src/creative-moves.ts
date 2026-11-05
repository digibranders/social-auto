/**
 * Creative moves: the few general ways a verified fact can become a visual idea. The concept writer chooses one of the moves the code allows
 * for the post's fact BEFORE it decides what to draw, and must say what the picture shows and how that corresponds to what the fact states.
 * A move is a communication technique, never a reference to an existing campaign, brand, slogan or picture, and it adds no claim: it only
 * constrains how the fact is shown. Which moves a fact may use comes from the fact's own category and wording; the settings are plain data.
 */
import type { EvidenceFact } from './evidence.ts';

export type MoveId = 'direct_demonstration' | 'input_output' | 'evidence_hero' | 'mapped_metaphor';

export interface CreativeMove {
  id: MoveId;
  /** One line for the writer. */
  principle: string;
  /** What the picture or graphic must make visible. */
  mustShow: string;
  /** What the move must not imply. */
  avoid: string;
}

export const CREATIVE_MOVES: Readonly<Record<MoveId, CreativeMove>> = {
  direct_demonstration: {
    id: 'direct_demonstration',
    principle: 'Show the stated capability being used, on an identifiable thing.',
    mustShow: 'who or what performs the action the fact states, and what it acts on',
    avoid: 'any result, speed or benefit the fact does not state',
  },
  input_output: {
    id: 'input_output',
    principle: 'Make one stated transformation visible, from what goes in to what comes out.',
    mustShow: 'a clear input, the stated operation, and the stated output',
    avoid: 'a better outcome than the fact promises; stages the fact does not name',
  },
  evidence_hero: {
    id: 'evidence_hero',
    principle: 'Let the verified figure, offer, quotation or credential itself be the centre of the poster.',
    mustShow: 'the statement with its units, period, conditions and attribution as the page gives them',
    avoid: 'detaching a condition or attribution; decoration that competes with the statement',
  },
  mapped_metaphor: {
    id: 'mapped_metaphor',
    principle: 'Express an abstract relationship the fact states through a familiar physical one, with a one-to-one correspondence.',
    mustShow: 'a physical relationship that corresponds point for point to the relationship in the fact',
    avoid: 'a symbol that means something else (complication, danger, delay) or that adds a claim; a generic symbol of connection, growth or speed',
  },
};

export interface MoveConfig {
  /** Verbs and words in a fact that suggest it states a transformation or a flow from one thing to another. */
  transformWords: readonly string[];
  /** The most moves offered for one fact. */
  maxMoves: number;
}

export const defaultMoveConfig: MoveConfig = {
  transformWords: ['turn', 'turns', 'convert', 'converts', 'transform', 'transforms', 'into', 'extract', 'extracts', 'generate', 'generates', 'build', 'builds', 'translate', 'translates', 'route', 'routes', 'send', 'sends', 'hand', 'hands', 'pass', 'passes', 'import', 'imports', 'export', 'exports', 'sync', 'syncs', 'move', 'moves', 'transfer', 'transfers', 'forward', 'forwards'],
  maxMoves: 3,
};

const EVIDENCE_CATEGORIES = new Set<EvidenceFact['category']>(['offer', 'commercial_term', 'credential', 'testimonial', 'outcome']);
const ACTION_CATEGORIES = new Set<EvidenceFact['category']>(['capability', 'process']);
const ABSTRACT_CATEGORIES = new Set<EvidenceFact['category']>(['capability', 'process', 'educational', 'identity']);

const hasWord = (text: string, words: readonly string[]): boolean => {
  const set = new Set(words);
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => set.has(w));
};

/**
 * The moves a post's facts allow, best first. The post's main fact decides (later facts only qualify it). A fact that states a figure, offer,
 * credential or testimonial is shown as the evidence itself; a capability or process may be demonstrated or, when it states a flow, shown as
 * input to output; a mapped metaphor is offered last for facts that state an abstract relationship, and is the one the picture judge checks hardest.
 */
export function eligibleMoves(facts: readonly EvidenceFact[], config: MoveConfig = defaultMoveConfig): MoveId[] {
  const main = facts[0];
  if (!main) return [];
  const moves: MoveId[] = [];
  const evidence = EVIDENCE_CATEGORIES.has(main.category) || main.values.numbers.length > 0 || main.values.prices.length > 0;
  if (evidence) moves.push('evidence_hero');
  if (ACTION_CATEGORIES.has(main.category)) {
    moves.push('direct_demonstration');
    if (hasWord(main.text, config.transformWords)) moves.push('input_output');
  }
  if (ABSTRACT_CATEGORIES.has(main.category)) moves.push('mapped_metaphor');
  return [...new Set(moves)].slice(0, config.maxMoves);
}

/** The moves in the words the concept writer is given for one post. */
export function moveBrief(ids: readonly MoveId[]): string {
  return ids.map((id) => {
    const move = CREATIVE_MOVES[id];
    return `${id}: ${move.principle} The picture must show ${move.mustShow}. It must not imply ${move.avoid}.`;
  }).join(' | ');
}

export const isMoveId = (value: unknown): value is MoveId => typeof value === 'string' && value in CREATIVE_MOVES;
