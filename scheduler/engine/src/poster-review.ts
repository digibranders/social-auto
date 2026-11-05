/**
 * The automated eye on a finished poster. One vision request per poster: the model first describes what is actually visible, then
 * compares that with the headline and the verified fact, then scores four things 0-2. It is shown the poster, the copy and the source
 * fact, never the art brief, so it cannot simply agree with the picture's intended meaning. Factual support stays with the claim gate.
 *
 * The decision (accept, repair, discard) is derived here from the scores and defect codes, not taken from the model's say-so, and a repair is
 * only ever one that costs no new picture. Each review is budget-checked before it is requested; a poster that cannot be reviewed within the
 * budget is reported as unreviewed and must not be treated as approved.
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AiConfig } from './ai.ts';
import { chatJson } from './llm.ts';

/** What can be done about a defect without buying another picture. */
export type RepairKind = 'rewrite_copy' | 'drop_subline' | 'drop_picture' | 'recrop' | 'move_cta' | 'relayout';

export const DEFECTS = {
  message_unclear: 'rewrite_copy',
  copy_repeats_itself: 'drop_subline',
  picture_irrelevant: 'drop_picture',
  picture_misleading: 'drop_picture',
  subject_cropped: 'recrop',
  subject_hidden: 'recrop',
  cta_covers_subject: 'move_cta',
  text_overlap: 'relayout',
  dead_space: 'relayout',
  low_contrast: 'relayout',
} as const satisfies Record<string, RepairKind>;

export type DefectCode = keyof typeof DEFECTS;
const DEFECT_CODES = Object.keys(DEFECTS) as DefectCode[];

export type Score = 0 | 1 | 2;

export interface PosterScores {
  message: Score;
  /** Null when the poster has no picture: the question does not apply, which is not a failure. */
  picture: Score | null;
  subject: Score | null;
  layout: Score;
}

export interface Defect {
  code: DefectCode;
  detail: string;
}

export interface PosterReview {
  observed: string;
  scores: PosterScores;
  defects: Defect[];
  decision: ReviewDecision;
}

export type ReviewDecision = { action: 'accept' } | { action: 'repair'; repairs: RepairKind[]; defects: DefectCode[] } | { action: 'discard'; reason: string };

/** The order repairs are applied in, and the most that one poster gets. */
export const REPAIR_ORDER: readonly RepairKind[] = ['drop_picture', 'rewrite_copy', 'drop_subline', 'recrop', 'move_cta', 'relayout'];
export const MAX_REPAIRS = 2;

export interface ReviewInput {
  key: string;
  /** Absolute path of the rendered poster. */
  imagePath: string;
  headline: string;
  subline?: string;
  /** The verbatim source text the post was written from. */
  fact: string;
  hasPicture: boolean;
}

export type ReviewOutcome = { status: 'reviewed'; review: PosterReview } | { status: 'skipped'; reason: 'budget' | 'failed'; detail?: string };

/** Planning figure for one review of a 1080x1080 poster on the default text model; the real price comes from the reply's token counts. */
export const REVIEW_COST_ESTIMATE_USD = 0.002;

const SYSTEM = `You are a strict art director reviewing one finished social media poster, shown as an image. You are also given the poster's headline and the source fact it was written from. You are not told what the picture is meant to show, so judge only what you can actually see.
Work in this order and return JSON only.
1. "observed": describe in one or two plain sentences what is visibly on the poster: the main objects in any picture and what they look like they are doing.
2. Compare what you see with the headline and the source fact.
3. Score four things, each 0, 1 or 2 (null for picture and subject when the poster has no picture):
 message: judge the wording as a stranger would read it, not whether it covers every detail of the source fact. 2 = understood at a glance; 1 = understandable with effort or awkward; 0 = unclear, a menu label or a specification line.
 picture: 2 = what the picture visibly shows helps explain the headline; 1 = related but loose; 0 = shows a different idea, or a metaphor that means something else (a tangled cord for "routes", a maze for "guides"), or could mislead.
 subject: 2 = the main subject of the picture is complete and clearly the focus; 1 = partly cut off or small; 0 = cut off so it is unrecognisable, or mostly empty space.
 layout: 2 = clean, balanced, nothing overlaps or covers anything important; 1 = a visible flaw (a large unintended empty area, crowded, a button over part of the picture's subject); 0 = text collides or is hard to read. Generous margins around type are not dead space.
4. List every defect you can point to as {"code","detail"}, where detail names what you see. Allowed codes: ${DEFECT_CODES.join(', ')}. List none when a score is 2. A score below 2 needs at least one defect that explains it.
Do not judge whether the claim is true, and do not reward a picture for being attractive. Return: {"observed":"...","scores":{"message":0,"picture":0,"subject":0,"layout":0},"defects":[{"code":"...","detail":"..."}]}`;

const isScore = (value: unknown): value is Score => value === 0 || value === 1 || value === 2;

/** Validates the model's JSON; throws a specific message so the corrective retry knows what to fix. */
export function parseReview(value: unknown, hasPicture: boolean): Omit<PosterReview, 'decision'> {
  const raw = value as { observed?: unknown; scores?: Record<string, unknown>; defects?: unknown };
  if (typeof raw.observed !== 'string' || !raw.observed.trim()) throw new Error('"observed" must describe what is visible');
  const scores = raw.scores;
  if (!scores || typeof scores !== 'object') throw new Error('"scores" must be an object');
  if (!isScore(scores.message) || !isScore(scores.layout)) throw new Error('"message" and "layout" scores must each be 0, 1 or 2');
  let picture: Score | null = null;
  let subject: Score | null = null;
  if (hasPicture) {
    if (!isScore(scores.picture) || !isScore(scores.subject)) throw new Error('this poster has a picture, so "picture" and "subject" must each be 0, 1 or 2');
    picture = scores.picture;
    subject = scores.subject;
  }
  if (!Array.isArray(raw.defects)) throw new Error('"defects" must be a list');
  const defects = raw.defects.flatMap((d): Defect[] => {
    const item = d as { code?: unknown; detail?: unknown };
    return typeof item.code === 'string' && (DEFECT_CODES as string[]).includes(item.code)
      ? [{ code: item.code as DefectCode, detail: typeof item.detail === 'string' ? item.detail.trim().slice(0, 240) : '' }]
      : [];
  });
  const result = { observed: raw.observed.trim().slice(0, 400), scores: { message: scores.message, picture, subject, layout: scores.layout }, defects };
  const lowest = Math.min(...[result.scores.message, picture, subject, result.scores.layout].filter((s): s is Score => s !== null));
  if (lowest < 2 && defects.length === 0) throw new Error('a score below 2 needs at least one defect with an allowed code');
  return result;
}

/**
 * Turns scores and defects into a decision. Only repairs that cost no new picture are automated (drop the picture, drop the subline, move the
 * CTA, choose another layout). A defect that would need a rewrite or a new crop is a note when its score is 1 and a discard when it is 0
 * (except a badly cropped picture, which is dropped). Dropping the picture also settles everything that belongs to it, so those are not counted
 * on top. What is left must need at most two kinds of repair, and no more than one score may be 0; otherwise the poster is discarded.
 */
export function decide(review: Omit<PosterReview, 'decision'>): ReviewDecision {
  const { scores, defects } = review;
  const all = [scores.message, scores.picture, scores.subject, scores.layout].filter((s): s is Score => s !== null);
  if (all.every((s) => s === 2)) return { action: 'accept' };
  if (all.filter((s) => s === 0).length > 1) return { action: 'discard', reason: 'more than one critical failure' };
  const wanted = new Set<RepairKind>();
  for (const { code } of defects) {
    const kind = DEFECTS[code];
    if (kind === 'rewrite_copy') {
      // A text-only poster is its headline, so an unclear one is not a note: there is nothing else to carry the message.
      if (scores.message === 0 || scores.picture === null) return { action: 'discard', reason: 'the headline is unclear and rewriting copy is not automated' };
    } else if (kind === 'recrop') {
      if (scores.subject === 0) wanted.add('drop_picture');
    } else {
      wanted.add(kind);
    }
  }
  if (wanted.has('drop_picture')) for (const covered of ['move_cta', 'relayout'] as const) wanted.delete(covered);
  const repairs = REPAIR_ORDER.filter((kind) => wanted.has(kind));
  if (repairs.length === 0) return all.includes(0) ? { action: 'discard', reason: 'a critical failure with no automatic repair' } : { action: 'accept' };
  if (repairs.length > MAX_REPAIRS) return { action: 'discard', reason: `needs ${repairs.length} kinds of repair (${repairs.join(', ')}); only ${MAX_REPAIRS} are attempted` };
  return { action: 'repair', repairs, defects: defects.map((d) => d.code) };
}

/**
 * After a repair there is no second one. A critical failure is discarded. So is a poster that is weak on everything it has: a text-only poster
 * whose message is not clear (a 2), or a picture poster whose message and picture are both only so-so. Anything else is accepted with its notes.
 */
export function decideAfterRepair(review: Omit<PosterReview, 'decision'>): ReviewDecision {
  const { scores } = review;
  const all = [scores.message, scores.picture, scores.subject, scores.layout].filter((s): s is Score => s !== null);
  if (all.includes(0)) return { action: 'discard', reason: 'still has a critical failure after the repair' };
  if (scores.picture === null && scores.message < 2) return { action: 'discard', reason: 'a text-only poster whose message is still not clear after the repair' };
  if (scores.picture !== null && scores.message === 1 && scores.picture === 1) return { action: 'discard', reason: 'both the message and the picture are only partly working after the repair' };
  return { action: 'accept' };
}

/** Tracks what review and repair may still spend: the cap applies to the money added since the budget was created. */
export class ReviewBudget {
  readonly capUsd: number;
  private readonly ai: AiConfig;
  private readonly startUsd: number;

  constructor(ai: AiConfig, capUsd: number) {
    this.ai = ai;
    this.capUsd = capUsd;
    this.startUsd = ai.usage.summary().totalUsd;
  }

  spentUsd(): number {
    return Math.round((this.ai.usage.summary().totalUsd - this.startUsd) * 1e8) / 1e8;
  }

  canAfford(estimateUsd: number): boolean {
    return this.spentUsd() + estimateUsd <= this.capUsd;
  }
}

export interface ReviewOptions {
  ai: AiConfig;
  posts: readonly ReviewInput[];
  budget: ReviewBudget;
  /** For tests. */
  fetchFn?: typeof fetch;
  readImage?: (path: string) => Promise<Buffer>;
}

async function reviewOne(options: ReviewOptions, input: ReviewInput): Promise<PosterReview> {
  const bytes = await (options.readImage ?? readFile)(input.imagePath);
  const user = `Review this poster.\n${JSON.stringify({ headline: input.headline, ...(input.subline ? { subline: input.subline } : {}), sourceFact: input.fact, hasPicture: input.hasPicture }, null, 2)}`;
  const parsed = await chatJson({
    ai: options.ai,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    system: SYSTEM,
    user,
    images: [`data:${extname(input.imagePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'};base64,${bytes.toString('base64')}`],
    parse: (value) => parseReview(value, input.hasPicture),
  });
  return { ...parsed, decision: decide(parsed) };
}

/** Reviews each poster in its own request, checking the budget first. A failed or unaffordable review is reported, never guessed. */
export async function reviewPosters(options: ReviewOptions): Promise<Map<string, ReviewOutcome>> {
  const outcomes = new Map<string, ReviewOutcome>();
  for (const input of options.posts) {
    if (!options.budget.canAfford(REVIEW_COST_ESTIMATE_USD)) {
      outcomes.set(input.key, { status: 'skipped', reason: 'budget' });
      continue;
    }
    try {
      outcomes.set(input.key, { status: 'reviewed', review: await reviewOne(options, input) });
    } catch (error) {
      outcomes.set(input.key, { status: 'skipped', reason: 'failed', detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
  }
  return outcomes;
}
