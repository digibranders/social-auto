/**
 * Concepts and the repeat check. Every post is written with a structured concept (what it is about, the angle, the one message, and what the
 * picture shows), kept in the brand's history once the post is accepted. A draft is compared with the history and with the rest of its own
 * plan before any picture is paid for. Repeated ideas are rejected, repeated business topics are not: a brand with one product may come back
 * to it from a different angle, and a new look for the same message only asks for a new picture. All thresholds and word lists are settings.
 */
import { clipToLimit } from './art-brief.ts';
import { normalizeHeadline } from './hooks.ts';
import { isMoveId, type MoveId } from './creative-moves.ts';

export interface Concept {
  /** What the post is about, in a few words. */
  subject: string;
  /** The particular angle on that subject. */
  angle: string;
  /** The one thing the post asserts. */
  message: string;
  /** The main object of the picture. */
  visualSubject: string;
  /** What happens to it. */
  visualAction: string;
  /** The framing: close-up, overhead, wide... */
  visualComposition: string;
  /** The creative move the picture idea was made for (see creative-moves.ts); absent on concepts written before moves existed. */
  moveId?: MoveId;
  /** What the picture visibly shows, in one sentence: the relationship the fact states, as the picture depicts it. */
  visualRelationship?: string;
  /** Why what the picture shows corresponds to what the fact states. It describes the mapping and is never evidence. */
  relationshipExplanation?: string;
}

export interface ConceptRecord {
  id: string;
  /** The post's date (ISO 8601). */
  date: string;
  concept: Concept;
  /** The headline as compared (see normalizeHeadline). */
  headline: string;
  pillar: string;
  hook: string;
  format: string;
  /** The proof point the post was built on. */
  anchor?: string;
  /** The older record this post deliberately returns to with a different message. */
  revisitOf?: string;
}

export interface ConceptConfig {
  /** How many of the latest accepted posts a draft is compared with. */
  historyWindow: number;
  /** A proof point is not used for the same pillar again within this many posts. */
  anchorWindow: number;
  /** The same subject and angle may come back after this many days, with a different message. */
  cooldownDays: number;
  /** How alike two short texts must be (shared content words, weighted) to count as the same. */
  similarity: number;
  /** Texts with this many content words or fewer must match exactly. */
  shortTextWords: number;
  stopwords: readonly string[];
  /** Words the brand treats as meaning the same ("delayed" -> "overdue"). Only what is listed is merged. */
  synonyms: Readonly<Record<string, string>>;
  /** A word in at least this share of the history says little about one post... */
  commonTermShare: number;
  /** ...but only once the history has this many posts. */
  commonTermMinHistory: number;
  /** ...and then counts this much. */
  commonTermWeight: number;
}

export const defaultConceptConfig: ConceptConfig = {
  historyWindow: 40,
  anchorWindow: 6,
  cooldownDays: 14,
  similarity: 0.75,
  shortTextWords: 2,
  // Negations are never stopwords: "do not lose data" is not "lose data".
  stopwords: ['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'is', 'are', 'was', 'were', 'be', 'it', 'its', 'this', 'that', 'your', 'you', 'our', 'we', 'do', 'does', 'as', 'into', 'about'],
  synonyms: {},
  commonTermShare: 0.5,
  commonTermMinHistory: 10,
  commonTermWeight: 0.3,
};

type RequiredField = 'subject' | 'angle' | 'message' | 'visualSubject' | 'visualAction' | 'visualComposition';
const FIELDS: ReadonlyArray<RequiredField> = ['subject', 'angle', 'message', 'visualSubject', 'visualAction', 'visualComposition'];
const MAX_FIELD_CHARS = 100;
/** The picture's subject and action establish what the picture shows; they are kept whole up to the picture limit and never cut. */
const ESSENTIAL_FIELDS: ReadonlyArray<RequiredField> = ['visualSubject', 'visualAction'];
const MAX_ESSENTIAL_CHARS = 160;

/** The concept the model wrote, checked field by field; a missing or malformed concept fails, so the repeat check can never be skipped. */
export function parseConcept(raw: unknown, allowedMoves?: readonly MoveId[]): Concept {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('"concept" must be an object with subject, angle, message, visualSubject, visualAction and visualComposition');
  const record = raw as Record<string, unknown>;
  const concept = {} as Concept;
  for (const field of FIELDS) {
    const value = record[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`"concept.${field}" must be short text`);
    if (ESSENTIAL_FIELDS.includes(field)) {
      if (value.trim().length > MAX_ESSENTIAL_CHARS) throw new Error(`"concept.${field}" must be at most ${MAX_ESSENTIAL_CHARS} characters; shorten it without losing what it names`);
      concept[field] = value.trim();
    } else {
      // A descriptive field a little over the limit is cut at a word, not refused: refusing it threw away a whole post and its facts over wording that only feeds the repeat check.
      concept[field] = clipToLimit(value, MAX_FIELD_CHARS);
    }
  }
  if (allowedMoves !== undefined && allowedMoves.length > 0) {
    const moveId = record['moveId'];
    if (!isMoveId(moveId) || !allowedMoves.includes(moveId)) throw new Error(`"concept.moveId" must be one of: ${allowedMoves.join(', ')}`);
    concept.moveId = moveId;
    for (const field of ['visualRelationship', 'relationshipExplanation'] as const) {
      const value = record[field];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`"concept.${field}" must be one short sentence`);
      concept[field] = clipToLimit(value, MAX_ESSENTIAL_CHARS);
    }
  } else if (isMoveId(record['moveId'])) {
    concept.moveId = record['moveId'];
    for (const field of ['visualRelationship', 'relationshipExplanation'] as const) {
      const value = record[field];
      if (typeof value === 'string' && value.trim()) concept[field] = clipToLimit(value, MAX_ESSENTIAL_CHARS);
    }
  }
  return concept;
}

export interface ConceptCandidate {
  concept: Concept;
  headline: string;
  pillar: string;
  date: string;
  anchor?: string;
}

export interface ConceptDecision {
  status: 'ok' | 'revisit' | 'duplicate_message' | 'duplicate_visual' | 'unchecked';
  reasons: string[];
  warnings: string[];
  /** The records the draft repeats or returns to. */
  matches: string[];
  revisitOf?: string;
}

const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokens(text: string, config: ConceptConfig): string[] {
  const stop = new Set(config.stopwords);
  return text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((word) => {
    let w = word;
    for (let i = 0; i < 5 && config.synonyms[w] !== undefined && config.synonyms[w] !== w; i++) w = config.synonyms[w] as string;
    return w;
  }).filter((w) => !stop.has(w)).map(stem);
}

const conceptText = (c: Concept): string => FIELDS.map((f) => c[f]).join(' ');

/** How much each word counts: a word that is in most of the brand's own posts says little about whether two of them are alike. */
function weights(history: readonly ConceptRecord[], config: ConceptConfig): (token: string) => number {
  if (history.length < config.commonTermMinHistory) return () => 1;
  const seen = new Map<string, number>();
  for (const record of history) for (const t of new Set(tokens(conceptText(record.concept), config))) seen.set(t, (seen.get(t) ?? 0) + 1);
  return (token) => ((seen.get(token) ?? 0) / history.length >= config.commonTermShare ? config.commonTermWeight : 1);
}

function same(a: string, b: string, config: ConceptConfig, weight: (t: string) => number): boolean {
  const [ta, tb] = [new Set(tokens(a, config)), new Set(tokens(b, config))];
  if (ta.size === 0 || tb.size === 0) return false;
  const shared = [...ta].filter((t) => tb.has(t));
  if (Math.min(ta.size, tb.size) <= config.shortTextWords) return ta.size === tb.size && shared.length === ta.size;
  const union = new Set([...ta, ...tb]);
  const sum = (set: Iterable<string>): number => [...set].reduce((total, t) => total + weight(t), 0);
  return sum(shared) / sum(union) >= config.similarity;
}

const DAY_MS = 86_400_000;

/**
 * Whether a draft repeats an idea already used, in the brand's accepted history (its latest posts) or earlier in the same plan. A repeated
 * message, or an identical headline, or the same proof point for the same pillar and angle too soon, needs a new idea; a repeated picture idea needs
 * only a new picture; the same subject and angle with a new message is allowed, as a warning soon after and as a labelled revisit after the
 * cooldown. Text in a script the check cannot compare is reported as unchecked, never passed as unique.
 */
export function checkConcept(candidate: ConceptCandidate, existing: { history: readonly ConceptRecord[]; batch: readonly ConceptRecord[] }, options: Partial<ConceptConfig> = {}): ConceptDecision {
  const config: ConceptConfig = { ...defaultConceptConfig, ...options };
  if (NO_SPACES.test(conceptText(candidate.concept))) {
    return { status: 'unchecked', reasons: ['the concept is in a script the repeat check cannot compare (words are not separated by spaces), so it could not be checked'], warnings: [], matches: [] };
  }
  const window = existing.history.slice(-config.historyWindow);
  const compared = [...window, ...existing.batch];
  const weight = weights(window, config);
  const headline = normalizeHeadline(candidate.headline);
  const c = candidate.concept;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const matches = new Set<string>();
  let messageRepeat = false;
  let visualRepeat = false;
  const topic: ConceptRecord[] = [];

  for (const record of compared) {
    const r = record.concept;
    const subject = same(c.subject, r.subject, config, weight);
    const angle = same(c.angle, r.angle, config, weight);
    const message = same(c.message, r.message, config, weight);
    if (record.headline === headline) {
      messageRepeat = true;
      matches.add(record.id);
      reasons.push(`the headline is the same as ${record.id}`);
    } else if (subject && angle && message) {
      messageRepeat = true;
      matches.add(record.id);
      reasons.push(`the same message on the same subject and angle as ${record.id} ("${r.message}")`);
    } else if (subject && angle) topic.push(record);
    if (same(c.visualSubject, r.visualSubject, config, weight) && same(c.visualAction, r.visualAction, config, weight) && same(c.visualComposition, r.visualComposition, config, weight)) {
      visualRepeat = true;
      matches.add(record.id);
      reasons.push(`the picture idea (visual) repeats ${record.id}: ${r.visualSubject}, ${r.visualAction}, ${r.visualComposition}`);
    }
  }
  const anchorNotes: string[] = [];
  if (candidate.anchor) {
    for (const record of compared.slice(-config.anchorWindow)) {
      if (record.anchor !== candidate.anchor || record.pillar !== candidate.pillar) continue;
      // The same proof point for the same pillar is a repeat when it also repeats the angle; from a different angle it is a new reading of it.
      if (same(c.angle, record.concept.angle, config, weight)) {
        messageRepeat = true;
        matches.add(record.id);
        reasons.push(`the same proof point for a "${candidate.pillar}" post, from the same angle, was used in ${record.id}, within the last ${config.anchorWindow} posts`);
      } else anchorNotes.push(`the proof point was also used for a "${candidate.pillar}" post in ${record.id}, from a different angle`);
    }
  }
  if (messageRepeat) return { status: 'duplicate_message', reasons, warnings, matches: [...matches] };
  if (visualRepeat) return { status: 'duplicate_visual', reasons, warnings, matches: [...matches] };

  const since = (record: ConceptRecord): number => (Date.parse(candidate.date) - Date.parse(record.date)) / DAY_MS;
  const recent = topic.filter((r) => existing.batch.includes(r) || since(r) < config.cooldownDays);
  if (recent.length > 0) {
    return { status: 'ok', reasons: [], warnings: [...anchorNotes, `same angle as ${recent[0]?.id} within ${config.cooldownDays} days, with a different message`], matches: recent.map((r) => r.id) };
  }
  if (topic.length > 0) {
    const origin = topic[0] as ConceptRecord;
    return { status: 'revisit', reasons: [], warnings: [...anchorNotes, `returns to the angle of ${origin.id} after ${config.cooldownDays} days with a different message`], matches: [origin.id], revisitOf: origin.id };
  }
  return { status: 'ok', reasons: [], warnings: [...warnings, ...anchorNotes], matches: [] };
}
