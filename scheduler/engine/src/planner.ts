/** Writes a week of pain-point posts for a brand with the text model. */
import type { AiConfig } from './ai.ts';
import { parseWeekPlan, type Brand, type LayoutName, type PlannedPost, type WeekPlan } from './content.ts';
import { assertCopySupported } from './copy-gate.ts';
import { creativePrompt, formatFor } from './creative.ts';
import { checkConcept, parseConcept, type Concept, type ConceptConfig, type ConceptRecord } from './concepts.ts';
import { assignHooks, checkHook, defaultHooks, fallbackHeadline, HookError, normalizeHeadline, repetitionWarnings, type HookSpec } from './hooks.ts';
import { assignWeek, checkAnchored, defaultPillars, type PillarSpec, type PostAssignment } from './pillars.ts';
import { postDates, type Weekday } from './cadence.ts';
import { visualStyleFor } from './layout.ts';
import { chatJson } from './llm.ts';

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

const SYSTEM_PROMPT = `You are a senior social media copywriter and art director for businesses of every size.
You write Instagram posts that each address one real customer pain point and show how the brand solves it.
Hard rules:
- Only use facts, prices and offers from the brand profile. Never invent statistics, customer counts, reviews or guarantees.
- No promises of rankings, leads, sales or medical/financial outcomes.
- Plain, warm, confident language. No hype words like "revolutionary" or "game-changer". No emojis in headlines.
Return a single JSON object and nothing else.`;

/** The pillar of each post in the order the model must write them, and the proof point a proof post is built on. */
function assignmentLines(assignments: readonly PostPlan[]): string {
  if (assignments.length === 0) return '';
  const lines = assignments.map((a, i) => `Post ${i + 1} (${a.hook ? `${a.pillar}, ${a.hook}` : a.pillar}): ${a.brief}${a.anchor ? ` Build it on this proof point: "${a.anchor}".` : ''}${a.hookBrief ? ` Headline hook: ${a.hookBrief}` : ''}`);
  return `\n\nEvery post belongs to a content pillar and opens with an assigned hook. Write the posts in this order, each following its pillar and hook:\n${lines.join('\n')}`;
}

/** What one post is assigned: its pillar and, when hooks are in use, its hook. */
export interface PostPlan extends PostAssignment {
  hook?: string;
  hookBrief?: string;
}

/** The most recent concepts, in a line each, so the writer sees which angles and pictures are taken; the repeat check, not this list, is what decides. */
function conceptLines(recent: readonly ConceptRecord[]): string {
  if (recent.length === 0) return '';
  const lines = recent.slice(-RECENT_CONCEPTS_IN_PROMPT).map((r, i) => `${i + 1}. ${r.concept.subject} / ${r.concept.angle} / ${r.concept.message} (picture: ${r.concept.visualSubject}, ${r.concept.visualAction}, ${r.concept.visualComposition})`);
  return `\n\nAvoid repeating these recent creative angles and pictures:\n${lines.join('\n')}\nYou may write about the same product or subject again, but with a genuinely different, evidence-supported message, and a different picture idea.`;
}

export function userPrompt(brand: Brand, count: number, usedPainPoints: string[], assignments: readonly PostPlan[] = [], recentConcepts: readonly ConceptRecord[] = []): string {
  return `Brand profile:
${JSON.stringify(
  {
    name: brand.name,
    website: brand.handleUrl,
    offer: brand.offer,
    audience: brand.audience,
    tone: brand.tone,
    proofPoints: brand.proofPoints,
    callToAction: brand.callToAction,
    rules: brand.rules,
  },
  null,
  2,
)}

Pain points already used in earlier weeks (do NOT repeat or rephrase these):
${usedPainPoints.length ? usedPainPoints.map((p) => `- ${p}`).join('\n') : '- none yet'}

Write ${count} posts, each on a different idea the audience cares about. Write every post for someone who has never heard of ${brand.name} and is scrolling fast: in three seconds they must understand the point of the post, whose post it is and what ${brand.name} does about it. Use plain words, no jargon, no internal product terms. A number, price, percentage, superlative (best, fastest, number one), guarantee or deadline may appear in the headline, subline or caption only if a proof point above states it, with that figure and wording unchanged; with no proof point for it, say the benefit in plain words instead. The hook is a pain they recognise from their own day, or a plain promise of the result, never a vague slogan; a post that is not about a pain states its point plainly instead.${assignmentLines(assignments)}${conceptLines(recentConcepts)}

Return JSON:
{
  "posts": [
    {
      "painPoint": "one sentence describing what the post is about (for a problem post, the customer's problem)",
      "headline": "max 45 characters, a punchy question or statement about the pain in everyday words; wrap the 2-4 most important words in |pipes| for the accent colour, e.g. 'Is your website |costing you customers?|'",
      "subline": "max 70 characters, plain words, no jargon: it names the brand (${brand.name}) and says what it does about this pain, e.g. '${brand.name} keeps all of this in one place.' Use only facts from the profile.",
      "visual": "one fresh visual idea for this pain point: a single symbolic object or abstract scene, in the way a clever magazine cover would. It must contain one object that belongs to the topic of the headline (a calendar for scheduling, a file or parcel for uploads, chat bubbles for conversation, a stack of tasks for repeated work), so a viewer links the picture to the headline within two seconds, plus one simple metaphor for the pain (a knot that unravels, a maze with one lit path). No people, no faces, no hands, no offices, desks or meeting rooms, no screens, no text. Max 30 words.",
      "visualLink": "one short sentence: how a viewer connects this picture to the headline, e.g. 'the parcel stands for big files and the narrow door for friction'",
      "concept": {"subject": "what the post is about, 2-5 words", "angle": "the particular angle on that subject", "message": "the one thing the post asserts", "visualSubject": "the main object in the picture", "visualAction": "what happens to it", "visualComposition": "the framing, e.g. close-up, overhead, wide"},
      "listItems": ["only for a numbered_list post: exactly as many distinct short items as the number the headline starts with; omit it for every other post"],
      "caption": "Instagram caption, 450-900 characters: hook line, the problem in the customer's words, how ${brand.name} solves it using real proof points, then the call to action. Use short paragraphs separated by blank lines (\\n\\n).",
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
export function buildPost(options: { draft: DraftPost; id: string; date: string; weekNumber: number; index: number; brand: Brand; pillar?: string; hook?: string; requestedHook?: string; warnings?: readonly string[]; concept?: Concept; anchor?: string; revisitOf?: string }): PlannedPost {
  const { draft, brand } = options;
  const format = formatFor(options.weekNumber, options.index);
  const items = options.hook === 'numbered_list' && draft.listItems ? draft.listItems.map((i) => i.trim()) : [];
  // The items a numbered headline counts are part of the caption, so the post keeps its promise.
  const caption = items.length > 0 ? `${draft.caption.trim()}\n\n${items.map((item, n) => `${n + 1}. ${item}`).join('\n')}` : draft.caption;
  const base = {
    id: options.id, date: options.date, painPoint: draft.painPoint, ...(options.pillar ? { pillar: options.pillar } : {}),
    ...(options.concept ? { concept: options.concept } : {}), ...(options.anchor ? { anchor: options.anchor } : {}), ...(options.revisitOf ? { revisitOf: options.revisitOf } : {}),
    ...(options.hook ? { hook: options.hook } : {}), ...(options.requestedHook ? { requestedHook: options.requestedHook } : {}),
    ...(options.warnings && options.warnings.length > 0 ? { hookWarnings: [...options.warnings] } : {}), ...(items.length > 0 ? { listItems: items } : {}),
    format, headline: draft.headline, subline: draft.subline, caption, hashtags: draft.hashtags,
  };
  if (format === 'type') return { ...base, mode: 'template' };
  return { ...base, mode: 'ai', imagePrompt: creativePrompt(format, draft.visual, brand) };
}

/** 70 is the target given to the model; allow some slack before forcing a retry. */
const MAX_SUBLINE_CHARS = 90;
/** How many recent concepts the writer is shown. */
const RECENT_CONCEPTS_IN_PROMPT = 10;
/** The headline limit given to the model is 45; this is the slack allowed before a draft is sent back. */
const MAX_HEADLINE_CHARS = 60;

/**
 * Turns back a draft the poster cannot be made from, so the model is asked again with the reason. With the brand's verified proof
 * points, it also turns back copy that states a figure, superlative, guarantee or deadline none of them supports; this runs before
 * any picture is generated.
 */
export function validateDraft(draft: DraftPost, position: number, brandName?: string, proofPoints?: readonly string[], assignment?: PostPlan): void {
  if (typeof draft.visual !== 'string' || !draft.visual.trim()) throw new Error(`post ${position} needs a "visual"`);
  if (typeof draft.visualLink !== 'string' || !draft.visualLink.trim()) throw new Error(`post ${position} needs a "visualLink": how the picture connects to the headline`);
  if (brandName !== undefined) {
    const first = brandName.trim().split(/\s+/)[0] ?? '';
    if (typeof draft.subline !== 'string' || draft.subline.length > MAX_SUBLINE_CHARS) throw new Error(`post ${position} subline is too long; keep it under 70 characters`);
    if (first && !draft.subline.toLowerCase().includes(first.toLowerCase())) throw new Error(`post ${position} subline must name the brand (${first}) so a stranger knows whose post it is`);
  }
  // 45 is the target given to the model; allow some slack before forcing a retry.
  if (typeof draft.headline === 'string' && draft.headline.replaceAll('|', '').length > 60) {
    throw new Error(`post ${position} headline is too long; keep it under 45 characters`);
  }
  const hookProblem = assignment?.hook ? checkHook({ hook: assignment.hook, headline: draft.headline, ...(draft.listItems ? { listItems: draft.listItems } : {}) }) : undefined;
  if (hookProblem) throw new HookError(`post ${position} (${assignment?.hook}): ${hookProblem}`);
  if (proofPoints !== undefined) assertCopySupported({ headline: draft.headline, subline: draft.subline, caption: [draft.caption, ...(draft.listItems ?? [])].join('\n') }, proofPoints, position);
  const unanchored = assignment?.anchor ? checkAnchored({ headline: draft.headline, subline: draft.subline, caption: draft.caption }, assignment.anchor) : undefined;
  if (assignment?.anchor && unanchored) {
    throw new Error(`post ${position} (${assignment.pillar}) must be built on this proof point: "${assignment.anchor}", with its figures and meaning unchanged: ${unanchored}`);
  }
}

/** A week plan, with a note when it holds fewer posts than asked for because the brand ran out of distinct, supported ideas. */
export interface PlannedWeek extends WeekPlan {
  insufficientConcepts?: { requested: number; produced: number; reasons: string[] };
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
  log?: (message: string) => void;
  /** Replaces the network for the text model; tests use it. */
  fetchFn?: typeof fetch;
}): Promise<PlannedWeek> {
  const { brand, schedule } = options;
  const dates = scheduleDates(schedule);
  const week = String(options.weekNumber).padStart(2, '0');
  const usedPainPoints = [...options.usedPainPoints];
  const posts: WeekPlan['posts'] = [];
  const recentPillars = options.recentPillars ?? [];
  const assignments = assignWeek({
    brand,
    count: dates.length,
    recent: recentPillars,
    recentAnchoredCount: recentPillars.filter((name) => (options.pillars ?? defaultPillars).find((p) => p.name === name)?.needs === 'proof').length,
    ...(options.pillars ? { pillars: options.pillars } : {}),
  });
  // Each post's hook is chosen together with its pillar, from the hooks that suit it and that the brand's evidence supports.
  const hookSpecs = options.hooks ?? defaultHooks;
  const hooks = assignHooks({ pillars: assignments.map((a) => a.pillar), evidence: { proofPoints: brand.proofPoints }, recentHooks: options.recentHooks ?? [], recentPillars: recentPillars, hooks: hookSpecs });
  const plans: PostPlan[] = assignments.map((a, i) => ({ ...a, hook: hooks[i] as string, hookBrief: hookSpecs.find((h) => h.id === hooks[i])?.brief ?? '' }));
  const identityLine = brand.identity && brand.identity.kind !== 'name-only' ? brand.identity.line : undefined;
  const recentConcepts = options.recentConcepts ?? [];
  /** Concepts of the posts accepted so far in this plan; later posts are compared with them as well as with history. */
  const acceptedRecords: ConceptRecord[] = [];
  const dropped: string[] = [];

  for (let offset = 0; offset < dates.length; offset += POSTS_PER_REQUEST) {
    const chunkDates = dates.slice(offset, offset + POSTS_PER_REQUEST);
    options.log?.(`writing posts ${offset + 1}-${offset + chunkDates.length} of ${dates.length}`);
    // The second try is the last: a headline that still does not follow its hook is then replaced by a safe, complete line, and a draft that
    // still repeats an earlier idea is left out of the plan (fewer posts, never a repeat); or the plan fails.
    let attempt = 0;
    let droppedHere: string[] = [];
    const chunk = await chatJson({
      ai: options.ai,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      system: SYSTEM_PROMPT,
      user: userPrompt(brand, chunkDates.length, usedPainPoints, plans.slice(offset, offset + chunkDates.length), [...recentConcepts, ...acceptedRecords]),
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
        (drafts as DraftPost[]).forEach((d, i) => {
          const assigned = plans[offset + i] as PostPlan;
          let draft = d;
          let used = assigned.hook as string;
          try {
            validateDraft(draft, i + 1, brand.name, brand.proofPoints, assigned);
          } catch (error) {
            if (!(error instanceof HookError) || attempt < 2) throw error;
            const headline = fallbackHeadline({ ...(assigned.anchor ? { anchor: assigned.anchor } : {}), ...(identityLine ? { identityLine } : {}), maxChars: MAX_HEADLINE_CHARS });
            if (!headline) throw error;
            draft = { ...d, headline };
            used = 'direct_statement';
            validateDraft(draft, i + 1, brand.name, brand.proofPoints, { ...assigned, hook: used });
          }
          let concept: Concept;
          try {
            concept = parseConcept(draft.concept);
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
            if (attempt < 2) {
              const fix = decision.status === 'duplicate_visual' ? 'keep the message, but write a new picture idea (the visual fields and "visual")' : 'write a different message or angle, supported by the profile';
              throw new Error(`post ${i + 1} repeats an earlier idea: ${why}. Please ${fix}`);
            }
            droppedHere.push(`post ${i + 1}: ${why}`);
            return;
          }
          const earlier = [...(options.recentHeadlines ?? []), ...posts.map((p) => p.headline), ...builtSoFar.map((p) => p.headline)].map(normalizeHeadline);
          const warnings = [...repetitionWarnings(draft.headline, earlier).map((w) => `${w.kind}: ${w.detail}`), ...decision.warnings.map((w) => `concept: ${w}`), ...(decision.status === 'unchecked' ? decision.reasons.map((r) => `concept: unchecked, ${r}`) : [])];
          const built = buildPost({
            draft, id: `w${week}-d${offset + i + 1}`, date, weekNumber: options.weekNumber, index: offset + i, brand,
            pillar: assigned.pillar, hook: used, warnings, concept, ...(assigned.anchor ? { anchor: assigned.anchor } : {}), ...(decision.revisitOf ? { revisitOf: decision.revisitOf } : {}),
            ...(used !== assigned.hook ? { requestedHook: assigned.hook as string } : {}),
          });
          builtSoFar.push(built);
          records.push(conceptRecordOf(built) as ConceptRecord);
          kept.push(built);
        });
        if (kept.length === 0) return [];
        return parseWeekPlan({ brand: options.brandSlug, timezone: schedule.utcOffset, posts: kept }, `week-${week}`).posts;
      },
    });
    dropped.push(...droppedHere);
    posts.push(...chunk);
    acceptedRecords.push(...chunk.map((p) => conceptRecordOf(p) as ConceptRecord));
    usedPainPoints.push(...chunk.map((p) => p.painPoint));
  }

  if (posts.length === 0) throw new InsufficientConceptsError(dates.length, dropped);
  const plan = parseWeekPlan({ brand: options.brandSlug, timezone: schedule.utcOffset, posts }, `week-${week}`);
  return dropped.length > 0 ? { ...plan, insufficientConcepts: { requested: dates.length, produced: posts.length, reasons: dropped } } : plan;
}
