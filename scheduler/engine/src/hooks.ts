/**
 * Hooks: the way a headline opens (a question, a plain benefit, a numbered list, a contrast, a direct statement, and, when the profile holds the
 * evidence for them, myth versus fact, before and after, how-to). Code assigns a hook to each post together with its pillar, from the hooks that
 * suit the pillar and that the brand's evidence supports, so a week does not open the same way every time. Hooks that would need invented
 * material (a transformation, steps, a common myth) are available only when the profile has that evidence. Checks here are hard (a structure the
 * code can verify, in any language) or warnings (repetition); whether a headline truly follows its hook is left to a later model review.
 * The hook set, compatibility and weights are settings.
 */

export type Strength = 'strong' | 'conditional' | 'weak';

export interface HookSpec {
  id: string;
  /** What the headline must do, given to the writer. */
  brief: string;
  /** The pillars it suits, and how well. A pillar not listed is not offered this hook. */
  compatible: Readonly<Record<string, Strength>>;
  /** The evidence the profile must hold before the hook may be used. */
  needs: 'beforeAfter' | 'steps' | 'myths' | null;
  /** How often it comes up compared with the others (1 when omitted); 0 switches it off. */
  weight?: number;
}

const ALL = (s: Strength): Record<string, Strength> => ({ problem: s, education: s, proof: s, offer: s, story: s });

export const defaultHooks: readonly HookSpec[] = [
  { id: 'question', brief: 'Open with one specific question the reader recognises, ending in a question mark.', needs: null, compatible: { problem: 'strong', education: 'strong', proof: 'conditional', offer: 'conditional', story: 'conditional' } },
  { id: 'benefit_statement', brief: 'State the value plainly, as a benefit the proof allows. Never promise an outcome the profile does not state.', needs: null, compatible: { problem: 'strong', education: 'conditional', proof: 'strong', offer: 'strong', story: 'conditional' } },
  { id: 'numbered_list', brief: 'Start the headline with the number of items (3 to 5) as a digit and return exactly that many distinct short items in "listItems". Use that number only at the start of the headline: do not state it again as a number in the subline or caption, and do not make it a quantity of anything (no "2 million", no percentages).', needs: null, compatible: { problem: 'conditional', education: 'strong', proof: 'conditional', offer: 'conditional', story: 'conditional' } },
  { id: 'myth_fact', brief: 'Correct one belief using the evidence given; never call something a common myth without that evidence.', needs: 'myths', compatible: { problem: 'conditional', education: 'strong', proof: 'conditional', offer: 'weak', story: 'weak' } },
  { id: 'before_after', brief: 'Show the verified before and after the evidence gives. Never invent a result.', needs: 'beforeAfter', compatible: { problem: 'conditional', education: 'conditional', proof: 'strong', offer: 'conditional', story: 'conditional' } },
  { id: 'direct_statement', brief: 'State one plain fact from the evidence as a statement, not a question.', needs: null, compatible: ALL('strong') },
  { id: 'how_to', brief: 'Start from the steps the evidence gives; never add steps or advice of your own.', needs: 'steps', compatible: { problem: 'conditional', education: 'strong', proof: 'weak', offer: 'conditional', story: 'strong' } },
  { id: 'contrast', brief: 'Set two states side by side ("from X to Y", "X, not Y") using only what the profile says; it is a contrast, not a claimed transformation.', needs: null, compatible: { problem: 'strong', education: 'strong', proof: 'conditional', offer: 'strong', story: 'conditional' } },
];

export interface HookEvidence {
  proofPoints: readonly string[];
  /** The profile holds a verified before and after. */
  beforeAfter?: boolean;
  /** The profile holds source-backed steps. */
  steps?: boolean;
  /** The profile holds evidence of a common belief and its correction. */
  myths?: boolean;
}

const hasEvidence = (hook: HookSpec, evidence: HookEvidence): boolean => hook.needs === null || evidence[hook.needs] === true;

/** The hooks the evidence allows and the settings leave on. */
export function availableHooks(evidence: HookEvidence, hooks: readonly HookSpec[] = defaultHooks): string[] {
  return hooks.filter((h) => (h.weight ?? 1) > 0 && hasEvidence(h, evidence)).map((h) => h.id);
}

const STRENGTH: Readonly<Record<Strength, number>> = { strong: 2, conditional: 1, weak: 0.2 };
const PAIR_WINDOW = 6;

/**
 * The hook of each post, chosen together with its pillar. Eligibility is a hard filter (the hook suits the pillar, its evidence exists, its
 * weight is above zero). Among the eligible, the hook furthest below its share this week wins, then below its share in recent weeks, then the
 * one whose pairing with this pillar was not used lately, then the better fit; the hook just used is skipped unless it is the only one.
 */
export function assignHooks(input: {
  pillars: readonly string[];
  evidence: HookEvidence;
  recentHooks: readonly string[];
  recentPillars: readonly string[];
  hooks?: readonly HookSpec[];
}): string[] {
  const specs = input.hooks ?? defaultHooks;
  const available = specs.filter((h) => (h.weight ?? 1) > 0 && hasEvidence(h, input.evidence));
  const window = input.recentHooks.slice(-available.length * 2);
  const week: string[] = [];
  input.pillars.forEach((pillar, slot) => {
    const eligible = available.filter((h) => h.compatible[pillar] !== undefined);
    if (eligible.length === 0) throw new Error(`no hook is available for a "${pillar}" post with this brand's evidence`);
    const hooks = [...input.recentHooks, ...week];
    const pillars = [...input.recentPillars, ...input.pillars.slice(0, slot)];
    const previous = hooks.at(-1);
    const candidates = eligible.filter((h) => h.id !== previous);
    const pool = candidates.length > 0 ? candidates : eligible;
    const aligned = Math.min(hooks.length, pillars.length);
    const recentPairs = hooks.slice(-aligned).map((h, i) => `${pillars.slice(-aligned)[i]}|${h}`).slice(-PAIR_WINDOW);
    const key = (h: HookSpec): number[] => [
      week.filter((w) => w === h.id).length / (h.weight ?? 1),
      window.filter((w) => w === h.id).length / (h.weight ?? 1),
      recentPairs.filter((p) => p === `${pillar}|${h.id}`).length,
      -STRENGTH[h.compatible[pillar] as Strength],
      specs.indexOf(h),
    ];
    const best = [...pool].sort((a, b) => {
      const [ka, kb] = [key(a), key(b)];
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (ka[i] as number) - (kb[i] as number);
      return 0;
    })[0] as HookSpec;
    week.push(best.id);
  });
  return week;
}

/** The headline as it is compared: accent markers, case, punctuation and extra spaces removed. */
export function normalizeHeadline(headline: string): string {
  return headline.replaceAll('|', '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const QUESTION_END = /[?？؟]\s*$/u;
const STATEMENT_HOOKS = new Set(['benefit_statement', 'direct_statement', 'contrast']);
const DEFAULT_MAX_LIST_ITEMS = 5;

/** A structural problem with a headline for its hook, or undefined. Only what code can verify; whether it truly follows the hook is for a model review. */
/** A numbered list of fewer items than this tells a reader too little to be worth the poster. */
export const MIN_LIST_ITEMS = 3;

export function checkHook(input: { hook: string; headline: string; listItems?: readonly string[]; maxListItems?: number }): string | undefined {
  const headline = input.headline.replaceAll('|', '').trim();
  if (input.hook === 'question') return QUESTION_END.test(headline) ? undefined : 'a question hook must end in a question mark';
  if (STATEMENT_HOOKS.has(input.hook)) return QUESTION_END.test(headline) ? 'a statement hook must be written as a statement, not a question' : undefined;
  if (input.hook !== 'numbered_list') return undefined;
  const items = input.listItems;
  if (!Array.isArray(items)) return 'a numbered list needs "listItems": the items the headline counts';
  const said = headline.normalize('NFKC').match(/^(\d{1,2})(?!\d)/);
  if (!said) return 'a numbered list headline must start with the number of items';
  const n = Number(said[1]);
  const max = input.maxListItems ?? DEFAULT_MAX_LIST_ITEMS;
  if (n < MIN_LIST_ITEMS || n > max) return `a numbered list has at most ${max} items (and at least ${MIN_LIST_ITEMS}: two is too thin to be a list), the headline says ${n}`;
  if (n !== items.length) return `the headline says ${n} but listItems has ${items.length}; they must match`;
  if (items.some((i) => typeof i !== 'string' || normalizeHeadline(i) === '')) return 'a list item is empty';
  if (items.some((i) => /[,;]/.test(i))) return 'each list item must be a single item, not several joined with commas: the headline counts them, so grouping items to reach a number misleads the reader';
  if (new Set(items.map(normalizeHeadline)).size !== items.length) return 'list items must be distinct';
  return undefined;
}

/** A headline that does not follow its assigned hook. The planner may answer a second failure with a safe fallback instead of another model call. */
export class HookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookError';
  }
}

export interface RepetitionWarning {
  kind: 'opening' | 'similar' | 'unsupported_language';
  detail: string;
}

const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const OPENING_WINDOW = 10;
const SIMILARITY_WINDOW = 20;
const trigrams = (tokens: readonly string[]): Set<string> => new Set(tokens.slice(2).map((_, i) => tokens.slice(i, i + 3).join(' ')));

/** Warnings, never failures: the same opening words as a recent headline, or a near-identical one. Skipped, and said to be, for scripts written without spaces. */
export function repetitionWarnings(headline: string, recentHeadlines: readonly string[], similarity = 0.5): RepetitionWarning[] {
  if (NO_SPACES.test(headline)) return [{ kind: 'unsupported_language', detail: 'repetition checks need words separated by spaces; skipped for this script' }];
  const tokens = normalizeHeadline(headline).split(' ').filter(Boolean);
  if (tokens.length < 3) return [];
  const warnings: RepetitionWarning[] = [];
  const opening = tokens.slice(0, 3).join(' ');
  const recent = recentHeadlines.map((h) => normalizeHeadline(h).split(' ').filter(Boolean));
  if (recent.slice(-OPENING_WINDOW).some((r) => r.slice(0, 3).join(' ') === opening)) warnings.push({ kind: 'opening', detail: `opens with "${opening}" like a recent headline` });
  const mine = trigrams(tokens);
  const near = recent.slice(-SIMILARITY_WINDOW).find((r) => {
    const theirs = trigrams(r);
    const shared = [...mine].filter((t) => theirs.has(t)).length;
    return mine.size + theirs.size - shared > 0 && shared / (mine.size + theirs.size - shared) >= similarity;
  });
  if (near) warnings.push({ kind: 'similar', detail: `very similar to a recent headline ("${near.join(' ')}")` });
  return warnings;
}

/**
 * A headline to use when the model failed twice: a complete line the evidence already supports, never a cut-off quote. A post built on a
 * proof point may only fall back to that whole proof point; any other post may use its brand's identity line. Undefined when none fits.
 */
export function fallbackHeadline(input: { anchor?: string; identityLine?: string; maxChars: number }): string | undefined {
  const candidate = input.anchor ?? input.identityLine;
  const text = candidate?.trim();
  return text && text.length <= input.maxChars ? text : undefined;
}
