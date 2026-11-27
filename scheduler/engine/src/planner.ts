/** Writes a week of pain-point posts for a brand with the text model. */
import { cleanPost, NO_DASH_RULE } from './no-dashes.ts';
import type { AiConfig } from './ai.ts';
import { parseWeekPlan, type Brand, type LayoutName, type PlannedPost, type WeekPlan } from './content.ts';
import { assertCopySupported } from './copy-gate.ts';
import { NETWORK_RULES } from './networks.ts';
import { checkCopyQuality, ownWordCount } from './copy-quality.ts';
import { brandPrefixProblem, planQualifierProblem } from './headline-rules.ts';
import { candidateCount, selectBest, type Candidate } from './candidate-selection.ts';
import { reviewCandidates, type ReviewDeps, type ReviewOutcome } from './copy-review.ts';
import { creativePrompt, formatFor } from './creative.ts';
import { checkConcept, parseConcept, type Concept, type ConceptConfig, type ConceptRecord } from './concepts.ts';
import { assignHooks, checkHook, defaultHooks, fallbackHeadline, HookError, normalizeHeadline, repetitionWarnings, type HookSpec } from './hooks.ts';
import { eligibleMoves, moveBrief } from './creative-moves.ts';
import { assignWeek, checkAnchored, defaultPillars, type PillarSpec, type PostAssignment } from './pillars.ts';
import { postDates, type Weekday } from './cadence.ts';
import { visualStyleFor } from './layout.ts';
import { chatJson, LlmError } from './llm.ts';
import { isPricingText, validateEditorial } from './editorial.ts';
import { neutralCta } from './cta.ts';
import type { CallToAction } from './cta.ts';
import { memoryCache, verifyCopySupport, type Judge, type VerdictCache } from './semantic-verifier.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';
import { MIN_WORTH } from './worth.ts';
import { assignFacts, offerableFacts, rankFacts } from './fact-assignment.ts';

/**
 * The prompt for one post's background picture: the scene, then the brand's visual style (palette in words, mood, what to
 * avoid) when its profile has one, then lighting, composition hint and the no-text rule.
 */
export function scenePrompt(visual: string, layout: LayoutName, brand: Pick<Brand, 'visualStyle'>, withComposition: boolean): string {
  const scene = visual.trim().replace(/\.$/, '');
  const style = brand.visualStyle?.trim().replace(/\.$/, '');
  return `${scene}${style ? `. Visual style: ${style}` : ''}${visualStyleFor(layout, withComposition)}`;
}

export interface PlanSchedule {
  /** YYYY-MM-DD of the first post. */
  startDate: string;
  /** HH:MM local time for every post. */
  time: string;
  /** UTC offset of that local time, e.g. +05:30. */
  utcOffset: string;
  count: number;
  /** Post only on these days of the week; without it, posts go on consecutive days. */
  weekdays?: readonly Weekday[];
}

/** ISO dates at the same local time: consecutive days, or only the chosen weekdays. */
export function scheduleDates({ startDate, time, utcOffset, count, weekdays }: PlanSchedule): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error(`Invalid start date "${startDate}", expected YYYY-MM-DD`);
  if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`Invalid time "${time}", expected HH:MM`);
  if (!/^[+-]\d{2}:\d{2}$/.test(utcOffset)) throw new Error(`Invalid UTC offset "${utcOffset}", expected +HH:MM`);
  const days = weekdays
    ? postDates(startDate, count, weekdays)
    : Array.from({ length: count }, (_, i) => new Date(Date.parse(`${startDate}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  return days.map((day) => `${day}T${time}:00${utcOffset}`);
}

/** Writing tries per chunk: the first answer and two corrections, each naming every check that failed, before a post is left out. */
const WRITE_TRIES = 3;

/** What the writer is told about a caption and a proof point, in the first request and again in a top-up. It states the checks; it loosens none of them. */
export const CAPTION_RULES = 'Write each caption so it opens with what the headline promises and then adds one different detail: never say the headline again in other words, never repeat the hook, and never say the same thing twice in two sentences. When a post is built on a proof point or a fact, quote its wording, figures and meaning unchanged, in the headline, subline or caption, rather than rephrasing it.';

const SYSTEM_PROMPT = `You are a senior social media copywriter and art director for businesses of every size.
You write Instagram posts that each address one real customer pain point and show how the brand solves it.
Hard rules:
- Only use facts, prices and offers from the brand profile. Never invent statistics, customer counts, reviews or guarantees.
- No promises of rankings, leads, sales or medical/financial outcomes.
- Plain, warm, confident language. No hype words like "revolutionary" or "game-changer". No emojis in headlines.
- ${NO_DASH_RULE}
Return a single JSON object and nothing else.`;

/** How long a caption should be for the facts a post has: a soft target that follows the evidence, never a floor to pad up to. */
export function captionTarget(factCount: number): string {
  // Instagram's caption is this one, so what is asked for stays inside the range worth aiming for on Instagram (networks.ts).
  // The words Instagram's caption must have (networks.ts); the facts a post has do not change the range, they only decide what the words say.
  void factCount;
  return `${NETWORK_RULES.instagram.words?.min ?? 80} to ${NETWORK_RULES.instagram.words?.max ?? 120} words`;
}

/** The pillar of each post in the order the model must write them, and the proof point a proof post is built on. */
function assignmentLines(assignments: readonly PostPlan[], facts: ReadonlyArray<readonly EvidenceFact[]> = []): string {
  if (assignments.length === 0) return '';
  const lines = assignments.map((a, i) => {
    const mine = facts[i] ?? [];
    const factLines = mine.map((f, n) => (n === 0 ? ` Main fact (the one message of this post): "${displayFact(f)}"` : ` Supporting detail (it may qualify or explain the main fact; it is never a second message): \"${displayFact(f)}\"`));
    const allowed = mine.length > 0 ? ` Facts you may use for this post, in the website's exact words (use no other figure, price, plan, trial or term; write one proposition, and say nothing that is not in these facts):${factLines.join('')}.` : '';
    const target = mine.length > 0 ? ` Caption length for this post: ${captionTarget(mine.length)}; say each fact once and add no claim that is not in the facts; do not repeat a point to fill space.` : '';
    const moves = mine.length > 0 ? eligibleMoves(mine) : [];
    const move = moves.length > 0 ? ` Creative move for this post's picture idea: choose exactly one of these and write the concept for it, so the picture shows what the main fact states and nothing more: ${moveBrief(moves)}.` : '';
    const cta = a.cta ? ` Call to action for this post (use this one, not the profile's): "${a.cta.text}".` : '';
    return `Post ${i + 1} (${a.hook ? `${a.pillar}, ${a.hook}` : a.pillar}): ${a.brief}${a.anchor ? ` Build it on this proof point: "${a.anchor}".` : ''}${allowed}${target}${move}${cta}${a.hookBrief ? ` Headline hook: ${a.hookBrief}` : ''}`;
  });
  return `\n\nEvery post belongs to a content pillar and opens with an assigned hook. Write the posts in this order, each following its pillar and hook:\n${lines.join('\n')}`;
}

/** What one post is assigned: its pillar and, when hooks are in use, its hook. */
export interface PostPlan extends PostAssignment {
  hook?: string;
  hookBrief?: string;
  /** The call to action for this post when it differs from the brand's (the brand's points to pricing and the post is not about price or plan). */
  cta?: { text: string; reason: string };
}

/** The most recent concepts, in a line each, so the writer sees which angles and pictures are taken; the repeat check, not this list, is what decides. */
function conceptLines(recent: readonly ConceptRecord[]): string {
  if (recent.length === 0) return '';
  const lines = recent.slice(-RECENT_CONCEPTS_IN_PROMPT).map((r, i) => `${i + 1}. ${r.concept.subject} / ${r.concept.angle} / ${r.concept.message} (picture: ${r.concept.visualSubject}, ${r.concept.visualAction}, ${r.concept.visualComposition})`);
  return `\n\nAvoid repeating these recent creative angles and pictures:\n${lines.join('\n')}\nYou may write about the same product or subject again, but with a genuinely different, evidence-supported message, and a different picture idea.`;
}

/** True when a profile sentence states no figure, price or period, so it can reach the writer without being a claim nothing verified. */
export const figureFree = (text: string): boolean => !/[\p{N}$€£₹¥%]/u.test(text);

/** The profile as the writer sees it. With evidence facts, the free-text offer, rules, proof points and audience stay out (the facts are given per post; the audience line is unverified wording), and a tone that states a figure is left out too. */
export function profileForPrompt(brand: Brand, withFacts: boolean): Record<string, unknown> {
  if (!withFacts) return { name: brand.name, website: brand.handleUrl, offer: brand.offer, audience: brand.audience, tone: brand.tone, proofPoints: brand.proofPoints, callToAction: brand.callToAction, rules: brand.rules };
  return {
    name: brand.name,
    website: brand.handleUrl,
    // The audience line is the profile model's own wording about who the product is for, which nothing verified: a writer given it states it as a fact. Tone is style only.
    ...(figureFree(brand.tone) ? { tone: brand.tone } : {}),
    callToAction: brand.callToAction,
  };
}

export function userPrompt(brand: Brand, count: number, usedPainPoints: string[], assignments: readonly PostPlan[] = [], recentConcepts: readonly ConceptRecord[] = [], facts?: ReadonlyArray<readonly EvidenceFact[]>): string {
  const withFacts = facts !== undefined;
  const figureRule = withFacts
    ? 'A number, price, percentage, plan, trial, tax term, superlative (best, fastest, number one), guarantee or deadline may appear in the headline, subline or caption only if one of the facts listed for that post states it, with that figure, plan, qualifier and wording unchanged; with no fact for it, say the benefit in plain words instead. Write one clear, reader-relevant statement or question using only the meaning of the post\'s main fact: prefer a concrete action, capability, offer or stated outcome; do not turn a list of features into a headline, do not introduce benefits the fact does not state, and use plain wording instead of technical shorthand when it keeps the claim. A headline needs no verb, but it must not read like a menu item or a specification line (no semicolon-separated fragments).'
    : 'A number, price, percentage, superlative (best, fastest, number one), guarantee or deadline may appear in the headline, subline or caption only if a proof point above states it, with that figure and wording unchanged; with no proof point for it, say the benefit in plain words instead.';
  return `Brand profile:
${JSON.stringify(profileForPrompt(brand, withFacts), null, 2)}

Pain points already used in earlier weeks (do NOT repeat or rephrase these):
${usedPainPoints.length ? usedPainPoints.map((p) => `- ${p}`).join('\n') : '- none yet'}

Write ${count} posts, each on a different idea the audience cares about. Write every post for someone who has never heard of ${brand.name} and is scrolling fast: in three seconds they must understand the point of the post and what is offered or solved. Write each headline as a standalone advertising message, never as a label naming the company: the brand's name is shown separately on the poster, so do not begin a headline with "${brand.name}" followed by a colon or dash, and put the name inside a headline only when it is a natural part of the sentence and the message is clearer with it. When a figure or limit belongs to a named plan in the facts, name the plan in the headline ("Free plan: 5 active projects") or leave the figure out. Use plain words, no jargon, no internal product terms. ${figureRule} The hook is a pain they recognise from their own day, or a plain promise of the result, never a vague slogan; a post that is not about a pain states its point plainly instead. ${CAPTION_RULES}${assignmentLines(assignments, facts)}${conceptLines(recentConcepts)}

Return JSON:
{
  "posts": [
    {
      "painPoint": "one sentence describing what the post is about (for a problem post, the customer's problem)",
      "headline": "max 45 characters, a punchy question or statement about the pain in everyday words; wrap the 2-4 most important words in |pipes| for the accent colour, e.g. 'Is your website |costing you customers?|'",
      "subline": ${withFacts ? `"optional, max 70 characters: return an empty string unless it adds a detail, condition or fact from the post's facts that the headline does not already say; never restate the headline in other words"` : `"max 70 characters, plain words, no jargon: it names the brand (${brand.name}) and says what it does about this pain, e.g. '${brand.name} keeps all of this in one place.' Use only facts from the profile."`},
      "visual": "one fresh visual idea for this pain point: a single symbolic object or abstract scene, in the way a clever magazine cover would. It must contain one object that belongs to the topic of the headline (a calendar for scheduling, a file or parcel for uploads, chat bubbles for conversation, a stack of tasks for repeated work), so a viewer links the picture to the headline within two seconds, plus a picture idea that shows what the headline says rather than a symbol for a feeling. No people, no faces, no hands, no offices, desks or meeting rooms, no screens, no text. Max 30 words.",
      "visualLink": "one short sentence: how a viewer connects this picture to the headline, e.g. 'the parcel stands for big files and the narrow door for friction'",
      "concept": {"subject": "what the post is about, 2-5 words", "angle": "the particular angle on that subject", "message": "the one thing the post asserts", "visualSubject": "the main object in the picture", "visualAction": "what happens to it", "visualComposition": "the framing, e.g. close-up, overhead, wide"${withFacts ? `, "moveId": "the one creative move chosen for this post, from its list", "visualRelationship": "one sentence: what the picture visibly shows, as the fact states it (no knots, tangles, mazes or cords unless the fact is about them)", "relationshipExplanation": "one sentence: why what the picture shows corresponds to what the fact states"` : ''}},
      "listItems": ["only for a numbered_list post: exactly as many distinct short items as the number the headline starts with; omit it for every other post"],
      "caption": "${withFacts ? `Instagram caption (length as set for each post above): a hook line, then what the post's facts say, in plain words, then the call to action. Do not add benefits, outcomes, scenarios, customers, scope or capabilities that the facts do not state; the reader's situation may be put only as a question. Short paragraphs separated by blank lines (\\n\\n).` : `Instagram caption (450-900 characters): hook line, the problem in the customer's words, how ${brand.name} solves it using real proof points, then the call to action. Use short paragraphs separated by blank lines (\\n\\n).`}",
      "hashtags": ["6-8 relevant hashtags, each starting with #, last one the brand name"]
    }
  ]
}`;
}

export interface DraftPost {
  painPoint: string;
  headline: string;
  subline: string;
  visual: string;
  /** How a viewer connects the picture to the headline; the model must state it, which keeps the picture on topic. */
  visualLink: string;
  caption: string;
  hashtags: string[];
  /** For a numbered-list headline: the items it counts. */
  listItems?: string[];
  /** What the post is about and shows; checked for repeats before any picture is made. */
  concept?: unknown;
}

/**
 * One planned post from the model's draft. The format comes from the rotation in code, so a week varies whatever the model
 * writes: a type-only post needs no picture, the others get a prompt in the brand's own colours.
 */
export function buildPost(options: { draft: DraftPost; id: string; date: string; weekNumber: number; index: number; brand: Brand; pillar?: string; hook?: string; requestedHook?: string; warnings?: readonly string[]; concept?: Concept; anchor?: string; revisitOf?: string; factIds?: readonly string[]; evidenceChecks?: readonly string[]; cta?: CallToAction; ctaReason?: string }): PlannedPost {
  const { draft, brand } = options;
  const format = formatFor(options.weekNumber, options.index);
  const items = options.hook === 'numbered_list' && draft.listItems ? draft.listItems.map((i) => i.trim()) : [];
  // The items a numbered headline counts are part of the caption, so the post keeps its promise.
  const caption = items.length > 0 ? `${draft.caption.trim()}\n\n${items.map((item, n) => `${n + 1}. ${item}`).join('\n')}` : draft.caption;
  const base = {
    id: options.id, date: options.date, painPoint: draft.painPoint, ...(options.pillar ? { pillar: options.pillar } : {}),
    ...(options.concept ? { concept: options.concept } : {}), ...(options.anchor ? { anchor: options.anchor } : {}), ...(options.revisitOf ? { revisitOf: options.revisitOf } : {}),
    ...(options.hook ? { hook: options.hook } : {}), ...(options.requestedHook ? { requestedHook: options.requestedHook } : {}),
    ...(options.cta ? { cta: options.cta, ...(options.ctaReason ? { ctaReason: options.ctaReason } : {}) } : {}),
    ...(options.factIds && options.factIds.length > 0 ? { factIds: [...options.factIds], evidenceChecks: [...(options.evidenceChecks ?? [])] } : {}),
    ...(options.warnings && options.warnings.length > 0 ? { hookWarnings: [...options.warnings] } : {}), ...(items.length > 0 ? { listItems: items } : {}),
    format, headline: draft.headline, subline: draft.subline, caption, hashtags: draft.hashtags,
  };
  if (format === 'type') return { ...base, mode: 'template' };
  return { ...base, mode: 'ai', imagePrompt: creativePrompt(format, draft.visual, brand) };
}

/** The caption without the brand's own verified call to action, which is an invitation and not a claim the facts must support. */
/** Whether the writer, after its own corrective try, gave no answer that passed the checks. */
const isNoValidAnswer = (error: unknown): boolean => error instanceof LlmError && /^No valid response\./.test(error.message);

/**
 * A rewritten caption with the engine's own closing line put back: the new body, a blank line, then the closing line. The closing line is never run on to the
 * last sentence ("...your business.Explore our services at acme.com (link in bio)"), whatever whitespace the old caption had at that spot.
 */
export function recomposeCaption(body: string, tail: string): string {
  const closing = tail.trim();
  return closing === '' ? body : `${body.replace(/\s+$/, '')}\n\n${closing}`;
}

export function withoutCta(caption: string, cta: string): string {
  const text = cta.trim();
  if (text === '') return caption;
  const bare = text.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return [text, bare].filter(Boolean).reduce((c, t) => c.split(t).join(' '), caption).replace(/[ \t]+/g, ' ').replace(/\s+\n/g, '\n').trim();
}

/** 70 is the target given to the model; allow some slack before forcing a retry. */
const MAX_SUBLINE_CHARS = 90;
/** How many recent concepts the writer is shown. */
const RECENT_CONCEPTS_IN_PROMPT = 10;
/** The headline limit given to the model is 45; this is the slack allowed before a draft is sent back. */
const MAX_HEADLINE_CHARS = 60;

/** Words that make a leading number a quantity ("2 million customers"), never a list size. */
const MAGNITUDE = /^\|?(?:hundred|thousand|million|billion|trillion|k|m|bn|percent|x)\b|^%/iu;

/**
 * The number a numbered-list headline starts with counts the list's own items: an editorial list size, not a claim. That one
 * leading occurrence is taken out of the headline before the claim gate looks (unless it is followed by a magnitude word or a
 * percent sign, which make it a quantity). The subline and caption are never touched, and every other figure is still gated. Only
 * called once the hook check has confirmed the count matches the list items.
 */
function withoutListCount<T extends { headline: string; subline: string; caption: string }>(copy: T): T {
  const said = copy.headline.normalize('NFKC').match(/^(\s*)(\d{1,2})\s+(?=\S)/u);
  if (!said) return copy;
  const rest = copy.headline.normalize('NFKC').slice(said[0].length);
  if (MAGNITUDE.test(rest)) return copy;
  return { ...copy, headline: rest };
}

/**
 * Turns back a draft the poster cannot be made from, so the model is asked again with the reason. With the brand's verified proof
 * points, it also turns back copy that states a figure, superlative, guarantee or deadline none of them supports; this runs before
 * any picture is generated.
 */
export function validateDraft(draft: DraftPost, position: number, brandName?: string, proofPoints?: readonly string[], assignment?: PostPlan, options: { optionalSubline?: boolean; facts?: readonly EvidenceFact[]; captionWords?: { min: number; max: number } } = {}): void {
  if (typeof draft.visual !== 'string' || !draft.visual.trim()) throw new Error(`post ${position} needs a "visual"`);
  if (typeof draft.visualLink !== 'string' || !draft.visualLink.trim()) throw new Error(`post ${position} needs a "visualLink": how the picture connects to the headline`);
  if (brandName !== undefined) {
    const first = brandName.trim().split(/\s+/)[0] ?? '';
    const none = options.optionalSubline === true && typeof draft.subline === 'string' && draft.subline.trim() === '';
    if (typeof draft.subline !== 'string' || draft.subline.length > MAX_SUBLINE_CHARS) throw new Error(`post ${position} subline is too long; keep it under 70 characters`);
    // With facts the subline is optional: a poster whose logo and identity line already say whose it is needs no line that names the brand, and a redundant subline is worse than none.
    if (!none && !(options.optionalSubline === true) && first && !draft.subline.toLowerCase().includes(first.toLowerCase())) throw new Error(`post ${position} subline must name the brand (${first}) so a stranger knows whose post it is`);
  }
  // 45 is the target given to the model; allow some slack before forcing a retry.
  if (typeof draft.headline === 'string' && draft.headline.replaceAll('|', '').length > 60) {
    throw new Error(`post ${position} headline is too long; keep it under 45 characters`);
  }
  const weak = checkCopyQuality({ headline: draft.headline, caption: draft.caption });
  if (weak) throw new Error(`post ${position} failed the writing check: ${weak}`);
  // The word range of the caption (the post's own words, without hashtags or the closing line): asked for while a correction is still possible. The last try accepts what it gets, so a plan never fails over length.
  if (options.captionWords !== undefined && typeof draft.caption === 'string') {
    const count = ownWordCount(draft.caption);
    const { min, max } = options.captionWords;
    if (count < min) throw new Error(`post ${position} caption is too short: ${count} words; it must be between ${min} and ${max} words (a hook, then what the post's facts say in plain words, then the call to action), using only what the facts state`);
    if (count > max) throw new Error(`post ${position} caption is too long: ${count} words; it must be between ${min} and ${max} words, so cut it to at most ${max}`);
  }
  // A headline is a message, not a label, and a figure that belongs to a plan keeps its plan (headline-rules.ts); each is asked for again once, then the post is left out.
  const prefix = brandName !== undefined && typeof draft.headline === 'string' ? brandPrefixProblem(draft.headline, brandName) : undefined;
  if (prefix) throw new Error(`post ${position} headline rule: ${prefix}`);
  const qualifier = options.facts && typeof draft.headline === 'string' ? planQualifierProblem(draft.headline, options.facts) : undefined;
  if (qualifier) throw new Error(`post ${position} headline rule: ${qualifier}`);
  const hookProblem = assignment?.hook ? checkHook({ hook: assignment.hook, headline: draft.headline, ...(draft.listItems ? { listItems: draft.listItems } : {}) }) : undefined;
  if (hookProblem) throw new HookError(`post ${position} (${assignment?.hook}): ${hookProblem}`);
  if (proofPoints !== undefined) {
    const copy = { headline: draft.headline, subline: draft.subline, caption: [draft.caption, ...(draft.listItems ?? [])].join('\n') };
    assertCopySupported(assignment?.hook === 'numbered_list' ? withoutListCount(copy) : copy, proofPoints, position);
  }
  const unanchored = assignment?.anchor ? checkAnchored({ headline: draft.headline, subline: draft.subline, caption: draft.caption }, assignment.anchor) : undefined;
  if (assignment?.anchor && unanchored) {
    throw new Error(`post ${position} (${assignment.pillar}) must be built on this proof point: "${assignment.anchor}", with its figures and meaning unchanged: ${unanchored}`);
  }
}

/** A week plan, with a note when it holds fewer posts than asked for because the brand ran out of distinct, supported ideas. */
/** What the week's copy was written and checked against: assigned evidence facts, or only the profile's proof points (legacy coverage). */
export type EvidenceCoverage = 'facts' | 'legacy';

/** What the claim gate does and does not check for a post written from facts. */
export const FACT_CHECKS = ['numbers_prices_periods_qualifiers_checked', 'semantic_support_unverified'] as const;

export interface PlannedWeek extends WeekPlan {
  evidenceCoverage?: EvidenceCoverage;
  insufficientConcepts?: { requested: number; produced: number; reasons: string[] };
  /** With oversampling: validated candidates that were not chosen, best first. They are drafts, not approved content: before any is used they must pass every check again. */
  reserveDrafts?: PlannedPost[];
  /** With oversampling: how many candidates were written, what each review did, and which were chosen. */
  candidateReport?: { written: number; requested: number; reviews: Array<{ id: string; status: ReviewOutcome['status']; rewritten: boolean; reasons: string[]; trail: ReviewOutcome['trail'] }>; selected: string[]; skipped: Array<{ id: string; reason: string }>; scores: Record<string, number> };
}

/** Raised when not one draft was a new idea. The plan stops before any picture is made. */
export class InsufficientConceptsError extends Error {
  constructor(requested: number, reasons: readonly string[]) {
    super(`insufficient_distinct_concepts: none of the ${requested} posts was a new idea (${reasons.join(' | ')})`);
    this.name = 'InsufficientConceptsError';
  }
}

/** The history record of an accepted post, or undefined for a post written before concepts were kept. */
export function conceptRecordOf(post: PlannedPost): ConceptRecord | undefined {
  if (!post.concept) return undefined;
  return {
    id: post.id, date: post.date, concept: post.concept, headline: normalizeHeadline(post.headline), pillar: post.pillar ?? 'problem', hook: post.hook ?? 'direct_statement',
    format: post.format ?? 'type', ...(post.anchor ? { anchor: post.anchor } : {}), ...(post.revisitOf ? { revisitOf: post.revisitOf } : {}),
  };
}

/** Larger batches make the model repeat itself, so plans are written in chunks. */
export const POSTS_PER_REQUEST = 10;

export async function planWeek(options: {
  ai: AiConfig;
  brand: Brand;
  brandSlug: string;
  weekNumber: number;
  schedule: PlanSchedule;
  usedPainPoints: string[];
  /**
   * A line added to the end of the request to the writer. It makes a second request different from the first on purpose: the paid-call guard refuses an identical request
   * in the same job (so an accidental repeat is never paid for), and a request asked again must therefore say something new (the day, the ideas already in the plan).
   */
  requestNote?: string;
  /** The words a caption must have, asked for on the first tries only (the last accepts what it gets). Off when left out; the real run passes Instagram's range from networks.ts. */
  captionWords?: { min: number; max: number };
  /** Ask the picture for room where the layout puts its text (off by default; see IMAGE_COMPOSITION_HINT). */
  compositionHints?: boolean;
  /** The pillars of the posts written in earlier weeks, oldest first, so the mix carries on where it stopped. */
  recentPillars?: readonly string[];
  /** The pillar set; the default set when omitted. */
  pillars?: readonly PillarSpec[];
  /** The hooks of the posts written in earlier weeks, oldest first (the hooks actually used), so the mix carries on. */
  recentHooks?: readonly string[];
  /** The headlines of earlier posts, for repetition warnings. */
  recentHeadlines?: readonly string[];
  /** The hook set; the default set when omitted. */
  hooks?: readonly HookSpec[];
  /** The concepts of earlier accepted posts, oldest first, that a draft is compared with. */
  recentConcepts?: readonly ConceptRecord[];
  /** Thresholds and word lists of the repeat check. */
  conceptConfig?: Partial<ConceptConfig>;
  /** Evidence facts of the brand. With usable facts the writer is given facts per post instead of the free-text offer, rules and proof points, and the claim gate checks the copy against the post's own facts. */
  evidence?: { facts: readonly EvidenceFact[]; recentFactIds?: readonly string[]; /** Poster-worthiness totals (0 to 6) by fact id; with them, weak facts are held back and fewer posts are written when too few facts are worth a post. */ worth?: Readonly<Record<string, number>> };
  /** Optional: a judge that reads the week's copy once against its facts. A post it finds stronger than its facts is left out; one it cannot decide stays with a note. Only used with evidence facts. */
  copyJudge?: { judge: Judge; cache?: VerdictCache };
  /** Write more candidates than posts (one per distinct fact), review each with structured verdicts and at most one rewrite before any picture is bought, and keep the best. Only with evidence facts. */
  candidates?: { factor?: number; review: ReviewDeps };
  log?: (message: string) => void;
  /** Replaces the network for the text model; tests use it. */
  fetchFn?: typeof fetch;
}): Promise<PlannedWeek> {
  const { brand, schedule } = options;
  const allDates = scheduleDates(schedule);
  const week = String(options.weekNumber).padStart(2, '0');
  const usedPainPoints = [...options.usedPainPoints];
  const posts: WeekPlan['posts'] = [];
  const recentPillars = options.recentPillars ?? [];
  // With evidence facts, the facts replace the profile's proof points everywhere a post is built or checked; their order already carries the cooldown.
  const recentFactIds = options.evidence?.recentFactIds ?? [];
  const offerable = options.evidence ? offerableFacts(options.evidence.facts) : [];
  const evidenceMode = offerable.length > 0;
  const worth = options.evidence?.worth;
  const rankedFacts = evidenceMode ? rankFacts(offerable, recentFactIds, worth) : [];
  // With judged scores, only facts that are worth a post lead one; four verified facts do not justify four posters when only two are worth making.
  const strong = evidenceMode && worth ? rankedFacts.filter((f) => (worth[f.id] ?? 0) >= MIN_WORTH).length : Number.POSITIVE_INFINITY;
  const dates = strong < allDates.length ? allDates.slice(0, Math.max(1, strong)) : allDates;
  // More candidates than posts when asked: one per distinct eligible fact, never padded (with fewer eligible facts there are fewer candidates and fewer posts).
  const oversample = evidenceMode && options.candidates !== undefined;
  const eligibleFacts = Number.isFinite(strong) ? strong : offerable.length;
  const wanted = oversample ? candidateCount(dates.length, eligibleFacts, { ...(options.candidates?.factor !== undefined ? { factor: options.candidates.factor } : {}) }) : dates.length;
  const workDates = wanted <= dates.length ? dates.slice(0, wanted) : [...dates, ...Array.from({ length: wanted - dates.length }, (_, i) => dates[i % dates.length] as string)];
  const proofTexts = evidenceMode ? rankedFacts.map(displayFact) : brand.proofPoints;
  const pillarEvidence = evidenceMode ? { proofPoints: proofTexts, offer: rankedFacts.some((f) => f.category === 'commercial_term' || f.category === 'offer') ? 'evidence facts' : '', ...(brand.identity ? { identity: brand.identity } : {}) } : brand;
  const assignments = assignWeek({
    brand: pillarEvidence,
    count: workDates.length,
    recent: recentPillars,
    recentAnchoredCount: evidenceMode ? 0 : recentPillars.filter((name) => (options.pillars ?? defaultPillars).find((p) => p.name === name)?.needs === 'proof').length,
    ...(options.pillars ? { pillars: options.pillars } : {}),
  });
  // Each post's hook is chosen together with its pillar, from the hooks that suit it and that the brand's evidence supports.
  // A numbered list needs N distinct, supported items, and a post written from one or two facts cannot supply them without inventing a count or grouping items:
  // in fact mode the hook is not offered until list items come from a list the source itself states.
  const hookSpecs = (options.hooks ?? defaultHooks).filter((h) => !(evidenceMode && h.id === 'numbered_list'));
  const hooks = assignHooks({ pillars: assignments.map((a) => a.pillar), evidence: { proofPoints: proofTexts }, recentHooks: options.recentHooks ?? [], recentPillars: recentPillars, hooks: hookSpecs });
  const factsPerPost = evidenceMode ? assignFacts({ ...(worth ? { worth } : {}), facts: offerable, anchors: assignments.map((a) => (a.anchor ? rankedFacts.find((f) => displayFact(f) === a.anchor) : undefined)), recentFactIds }) : [];
  const host = brand.handleUrl?.trim() ?? '';
  const ctaFor = (position: number): PostPlan['cta'] => {
    const mine = factsPerPost[position] ?? [];
    if (!evidenceMode || mine.length === 0 || host === '' || !isPricingText(brand.callToAction)) return undefined;
    if (mine.some((f) => f.category === 'commercial_term' || f.category === 'offer')) return undefined;
    return { text: neutralCta(host).text, reason: 'cta_relevance_fallback: the brand call to action points to pricing and the post is not about price or plan' };
  };
  const plans: PostPlan[] = assignments.map((a, i) => ({ ...a, hook: hooks[i] as string, hookBrief: hookSpecs.find((h) => h.id === hooks[i])?.brief ?? '', ...(ctaFor(i) ? { cta: ctaFor(i) as NonNullable<PostPlan['cta']> } : {}) }));
  const identityLine = brand.identity && brand.identity.kind !== 'name-only' ? brand.identity.line : undefined;
  const recentConcepts = options.recentConcepts ?? [];
  /** Concepts of the posts accepted so far in this plan; later posts are compared with them as well as with history. */
  const acceptedRecords: ConceptRecord[] = [];
  const dropped: string[] = [];
  /** What the claim gate checks the post at this position against: its own assigned facts, or the profile's proof points. */
  const gateEvidence = (position: number): readonly string[] => (evidenceMode ? (factsPerPost[position] ?? []).map(displayFact) : brand.proofPoints);

  for (let offset = 0; offset < workDates.length; offset += POSTS_PER_REQUEST) {
    const chunkDates = workDates.slice(offset, offset + POSTS_PER_REQUEST);
    options.log?.(`writing ${oversample ? 'candidates' : 'posts'} ${offset + 1}-${offset + chunkDates.length} of ${workDates.length}`);
    // The second try is the last: a headline that still does not follow its hook is then replaced by a safe, complete line, and a draft that
    // still repeats an earlier idea is left out of the plan (fewer posts, never a repeat); or the plan fails.
    let attempt = 0;
    let droppedHere: string[] = [];
    const writeChunk = (retryNote?: string): Promise<PlannedPost[]> => chatJson({
      ai: options.ai,
      attempts: WRITE_TRIES,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      system: SYSTEM_PROMPT,
      user: userPrompt(brand, chunkDates.length, usedPainPoints, plans.slice(offset, offset + chunkDates.length), [...recentConcepts, ...acceptedRecords], evidenceMode ? factsPerPost.slice(offset, offset + chunkDates.length) : undefined) + [options.requestNote, retryNote].filter((n): n is string => n !== undefined && n !== '').map((n) => `\n\n${n}`).join(''),
      parse: (value) => {
        attempt += 1;
        droppedHere = [];
        const drafts = (value as { posts?: unknown }).posts;
        if (!Array.isArray(drafts) || drafts.length !== chunkDates.length) {
          throw new Error(`"posts" must contain exactly ${chunkDates.length} items`);
        }
        const builtSoFar: PlannedPost[] = [];
        const records: ConceptRecord[] = [];
        const kept: PlannedPost[] = [];
        // Every post that needs a correction is named in one message, so the next try fixes them all (the model is told which check each one failed), not only the first.
        const problems: string[] = [];
        (drafts as DraftPost[]).forEach((d, i) => {
          try {
          const assigned = plans[offset + i] as PostPlan;
          let draft = d;
          let used = assigned.hook as string;
          try {
            validateDraft(draft, i + 1, brand.name, gateEvidence(offset + i), assigned, { optionalSubline: evidenceMode, facts: factsPerPost[offset + i] ?? [], ...(attempt < WRITE_TRIES && options.captionWords !== undefined ? { captionWords: options.captionWords } : {}) });
          } catch (error) {
            // On the last try a post whose copy the claim gate still turns back, or that does not stay with its fact, is left out (fewer posts, never unsupported copy); the others stay.
            if (attempt >= WRITE_TRIES && !(error instanceof HookError) && error instanceof Error && /claim gate turned back|must be built on this proof point|headline rule:|failed the writing check/.test(error.message)) {
              droppedHere.push(error.message);
              return;
            }
            if (!(error instanceof HookError) || attempt < WRITE_TRIES) throw error;
            const headline = fallbackHeadline({ ...(assigned.anchor ? { anchor: assigned.anchor } : {}), ...(identityLine ? { identityLine } : {}), maxChars: MAX_HEADLINE_CHARS });
            if (!headline) throw error;
            draft = { ...d, headline };
            used = 'direct_statement';
            validateDraft(draft, i + 1, brand.name, gateEvidence(offset + i), { ...assigned, hook: used }, { optionalSubline: evidenceMode, facts: factsPerPost[offset + i] ?? [] });
          }
          let concept: Concept;
          try {
            concept = parseConcept(draft.concept, evidenceMode ? eligibleMoves(factsPerPost[offset + i] ?? []) : undefined);
          } catch (error) {
            throw new Error(`post ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
          }
          const date = chunkDates[i] as string;
          const decision = checkConcept(
            { concept, headline: draft.headline, pillar: assigned.pillar, date, ...(assigned.anchor ? { anchor: assigned.anchor } : {}) },
            { history: recentConcepts, batch: [...acceptedRecords, ...records] },
            options.conceptConfig,
          );
          if (decision.status === 'duplicate_message' || decision.status === 'duplicate_visual') {
            const why = decision.reasons.join('; ');
            if (attempt < WRITE_TRIES) {
              const fix = decision.status === 'duplicate_visual' ? 'keep the message, but write a new picture idea (the visual fields and "visual")' : 'write a different message or angle, supported by the profile';
              throw new Error(`post ${i + 1} repeats an earlier idea: ${why}. Please ${fix}`);
            }
            droppedHere.push(`post ${i + 1}: ${why}`);
            return;
          }
          // Editorial: a subline that only says the headline or identity line again goes back to the writer; on the last try it stays, with the reason noted for the reviewer.
          const cited = evidenceMode ? (factsPerPost[offset + i] ?? []).map((f) => ({ text: f.text, category: f.category })) : [];
          const editorial = validateEditorial({ headline: draft.headline, subline: draft.subline, caption: draft.caption }, { brandName: brand.name, ...(identityLine ? { identityLine } : {}), cta: assigned.cta?.text ?? brand.callToAction, citedFacts: cited }, evidenceMode ? { nearIdentical: 0.5 } : { nearIdentical: 0.6 });
          if (editorial.hard.length > 0 && attempt < WRITE_TRIES) throw new Error(`post ${i + 1}: ${editorial.hard.map((h) => h.message).join('; ')}`);
          // A subline that says the headline again, exactly or in nearly the same words with nothing new supported, is not copy. With facts the subline is optional, so on the last
          // try it is taken away and the post stays (a redundant subline is worse than none); without facts the post is left out.
          let removedSubline = false;
          if (editorial.hard.length > 0) {
            if (!evidenceMode) {
              droppedHere.push(`post ${i + 1}: ${editorial.hard.map((h) => h.message).join('; ')}`);
              return;
            }
            draft = { ...draft, subline: '' };
            removedSubline = true;
          }
          const editorialNotes = [...(removedSubline ? ['editorial: subline_removed_as_redundant'] : []), ...editorial.warnings.map((issue) => `editorial: ${issue.code}`)];
          const earlier = [...(options.recentHeadlines ?? []), ...posts.map((p) => p.headline), ...builtSoFar.map((p) => p.headline)].map(normalizeHeadline);
          const warnings = [...repetitionWarnings(draft.headline, earlier).map((w) => `${w.kind}: ${w.detail}`), ...decision.warnings.map((w) => `concept: ${w}`), ...editorialNotes, ...(decision.status === 'unchecked' ? decision.reasons.map((r) => `concept: unchecked, ${r}`) : [])];
          const built = buildPost({
            draft, id: `w${week}-d${offset + i + 1}`, date, weekNumber: options.weekNumber, index: offset + i, brand,
            pillar: assigned.pillar, hook: used, warnings, concept, ...(assigned.anchor ? { anchor: assigned.anchor } : {}), ...(decision.revisitOf ? { revisitOf: decision.revisitOf } : {}),
            ...(used !== assigned.hook ? { requestedHook: assigned.hook as string } : {}),
            ...(evidenceMode ? { factIds: (factsPerPost[offset + i] ?? []).map((f) => f.id), evidenceChecks: [...FACT_CHECKS] } : {}),
            ...(assigned.cta ? { cta: neutralCta(host), ctaReason: assigned.cta.reason } : {}),
          });
          builtSoFar.push(built);
          records.push(conceptRecordOf(built) as ConceptRecord);
          kept.push(built);
          } catch (error) {
            if (attempt < WRITE_TRIES && error instanceof Error) problems.push(error.message);
            else throw error;
          }
        });
        if (problems.length > 0) throw new Error(`${problems.join('\n')}\nRewrite the posts named above, fixing exactly what is said for each, and return all the posts; keep the others as they were. Do not loosen the facts: say what the facts say, in their words`);
        if (kept.length === 0) return [];
        return parseWeekPlan({ brand: options.brandSlug, timezone: schedule.utcOffset, posts: kept }, `week-${week}`).posts;
      },
    });
    // One bad answer must not cost the whole plan: when the writer gives no valid answer for a chunk (after its own corrective try), the chunk is asked for once more from
    // scratch; if that fails too, only that chunk is left out and the plan says so. The plan fails only when nothing valid remains (InsufficientConceptsError below).
    let chunk: PlannedPost[];
    try {
      chunk = await writeChunk();
    } catch (error) {
      if (!isNoValidAnswer(error)) throw error;
      options.log?.(`writing ${oversample ? 'candidates' : 'posts'} ${offset + 1}-${offset + chunkDates.length}: no valid answer, asking once more`);
      attempt = 0;
      droppedHere = [];
      try {
        chunk = await writeChunk('The first answer for these posts could not be used (it failed the writing checks). Write them again from scratch, as a fresh set, and check each caption against the writing rules before answering.');
      } catch (second) {
        if (!isNoValidAnswer(second)) throw second;
        dropped.push(`${oversample ? 'candidates' : 'posts'} ${offset + 1}-${offset + chunkDates.length}: the writer gave no valid answer twice, so they are left out (${(second as Error).message.replace(/^No valid response\.\s*/, '').slice(0, 200)})`);
        continue;
      }
    }
    dropped.push(...droppedHere);
    posts.push(...chunk);
    acceptedRecords.push(...chunk.map((p) => conceptRecordOf(p) as ConceptRecord));
    usedPainPoints.push(...chunk.map((p) => p.painPoint));
  }

  let reserveDrafts: PlannedPost[] | undefined;
  let candidateReport: PlannedWeek['candidateReport'];
  if (oversample && options.candidates && posts.length > 0) {
    const byId = new Map(offerable.map((f) => [f.id, f]));
    const split = (p: PlannedPost): { body: string; tail: string } => {
      let body = withoutCta(withoutCta(p.caption, brand.callToAction), p.cta?.text ?? '');
      // The engine's own call-to-action line ("Visit example.com (link in bio)") is not a claim of the post, whichever call to action produced it.
      const lines = body.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]?.trim() === '') continue;
        if (/\(link in bio\)\s*$/.test(lines[i] as string)) body = lines.slice(0, i).join('\n').replace(/\s+$/, '');
        break;
      }
      return { body, tail: p.caption.slice(body.length) };
    };
    const outcomes = await reviewCandidates(
      posts.map((p) => ({ id: p.id, draft: { headline: p.headline, subline: p.subline, caption: split(p).body }, facts: (p.factIds ?? []).flatMap((id) => byId.get(id) ?? []) })),
      options.candidates.review,
    );
    const survivors: PlannedPost[] = [];
    posts.forEach((p, i) => {
      const o = outcomes[i] as ReviewOutcome;
      if (o.status === 'dropped') { dropped.push(`${p.id}: ${o.reasons.join('; ')} [headline: "${p.headline}"]`); return; }
      const rewritten = o.rewritten ? { headline: o.draft.headline, subline: o.draft.subline, caption: recomposeCaption(o.draft.caption, split(p).tail) } : {};
      survivors.push({ ...p, ...rewritten, evidenceChecks: [...(p.evidenceChecks ?? []).filter((c) => c !== 'semantic_support_unverified'), o.rewritten ? 'semantic_support_rewritten_once' : 'semantic_support_structured_verdict'] });
    });
    const candidatesOut: Candidate[] = survivors.map((p) => ({ id: p.id, factId: (p.factIds ?? [''])[0] as string, headline: p.headline.replace(/\|/g, ''), proposition: p.painPoint, ...(worth?.[(p.factIds ?? [''])[0] as string] !== undefined ? { worth: worth?.[(p.factIds ?? [''])[0] as string] as number } : {}) }));
    const choice = selectBest(candidatesOut, dates.length, { recent: [...(options.recentHeadlines ?? []), ...recentConcepts.map((c) => `${c.headline} ${c.concept.message}`)] });
    const keepIds = choice.selected.map((c) => c.id);
    // The chosen posts take the real days in order, and their ids follow the days, so nothing downstream sees the candidates that were not chosen.
    const chosen = keepIds.map((id) => survivors.find((p) => p.id === id) as PlannedPost);
    reserveDrafts = choice.reserve.map((c) => survivors.find((p) => p.id === c.id) as PlannedPost);
    posts.splice(0, posts.length, ...chosen.map((p, i) => ({ ...p, id: `w${week}-d${i + 1}`, date: dates[i] as string })));
    candidateReport = { written: workDates.length, requested: dates.length, reviews: outcomes.map((o) => ({ id: o.id, status: o.status, rewritten: o.rewritten, reasons: o.reasons, trail: o.trail })), selected: keepIds, skipped: choice.skipped, scores: choice.scores };
    for (const s of choice.skipped) dropped.push(`${s.id}: left out, ${s.reason}`);
    options.log?.(`candidates: ${workDates.length} written, ${survivors.length} passed review, ${chosen.length} chosen, ${reserveDrafts.length} kept in reserve`);
  }
  if (evidenceMode && options.copyJudge && !oversample && posts.length > 0) {
    const byId = new Map(offerable.map((f) => [f.id, f]));
    const results = await verifyCopySupport(
      posts.map((p) => ({ copy: { headline: p.headline, subline: p.subline, caption: withoutCta(withoutCta(p.caption, brand.callToAction), p.cta?.text ?? '') }, facts: (p.factIds ?? []).flatMap((id) => byId.get(id) ?? []) })),
      options.copyJudge.judge, options.copyJudge.cache ?? memoryCache(), { tenant: options.brandSlug },
    );
    const kept: typeof posts = [];
    posts.forEach((p, i) => {
      const r = results[i] as (typeof results)[number];
      if (r.status === 'rejected') { dropped.push(`${p.id}: ${r.reasons.join('; ')} [headline: "${p.headline}" | subline: "${p.subline}" | facts: ${(p.factIds ?? []).map((id) => byId.get(id)).flatMap((f) => (f ? [`"${displayFact(f)}"`] : [])).join(', ')}]`); return; }
      const checks = (p.evidenceChecks ?? []).filter((c) => c !== 'semantic_support_unverified');
      kept.push({ ...p, evidenceChecks: [...checks, r.status === 'supported_by_model' ? 'semantic_support_model_judged' : 'semantic_support_unverified'], ...(r.status === 'uncertain' ? { hookWarnings: [...(p.hookWarnings ?? []), `evidence: ${r.reasons.join('; ')}`] } : {}) });
    });
    posts.splice(0, posts.length, ...kept);
  }
  if (posts.length === 0) throw new InsufficientConceptsError(allDates.length, dropped);
  const plan = parseWeekPlan({ brand: options.brandSlug, timezone: schedule.utcOffset, posts: posts.map(cleanPost) }, `week-${week}`);
  const coverage: EvidenceCoverage = evidenceMode ? 'facts' : 'legacy';
  if (dates.length < allDates.length) dropped.unshift(`only ${dates.length} fact${dates.length === 1 ? ' is' : 's are'} worth a post of its own (poster-worthiness ${MIN_WORTH} or more), so ${allDates.length - dates.length} fewer post${allDates.length - dates.length === 1 ? ' was' : 's were'} written`);
  const extra = { ...(reserveDrafts ? { reserveDrafts } : {}), ...(candidateReport ? { candidateReport } : {}) };
  return dropped.length > 0 ? { ...plan, evidenceCoverage: coverage, ...extra, insufficientConcepts: { requested: allDates.length, produced: posts.length, reasons: dropped } } : { ...plan, evidenceCoverage: coverage, ...extra };
}
