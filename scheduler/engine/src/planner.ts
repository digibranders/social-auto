/** Writes a week of pain-point posts for a brand with the text model. */
import type { AiConfig } from './ai.ts';
import { parseWeekPlan, type Brand, type LayoutName, type PlannedPost, type WeekPlan } from './content.ts';
import { creativePrompt, formatFor } from './creative.ts';
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

export function userPrompt(brand: Brand, count: number, usedPainPoints: string[]): string {
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

Write ${count} posts, each on a different pain point the audience really has. Return JSON:
{
  "posts": [
    {
      "painPoint": "one sentence describing the customer's problem",
      "headline": "max 45 characters, a punchy question or statement about the pain; wrap the 2-4 most important words in |pipes| for the accent colour, e.g. 'Is your website |costing you customers?|'",
      "subline": "max 70 characters, one line that hints at the solution",
      "visual": "one fresh visual idea for this pain point: a single symbolic object or abstract scene, in the way a clever magazine cover would. It must contain one object that belongs to the topic of the headline (a calendar for scheduling, a file or parcel for uploads, chat bubbles for conversation, a stack of tasks for repeated work), so a viewer links the picture to the headline within two seconds, plus one simple metaphor for the pain (a knot that unravels, a maze with one lit path). No people, no faces, no hands, no offices, desks or meeting rooms, no screens, no text. Max 30 words.",
      "visualLink": "one short sentence: how a viewer connects this picture to the headline, e.g. 'the parcel stands for big files and the narrow door for friction'",
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
}

/**
 * One planned post from the model's draft. The format comes from the rotation in code, so a week varies whatever the model
 * writes: a type-only post needs no picture, the others get a prompt in the brand's own colours.
 */
export function buildPost(options: { draft: DraftPost; id: string; date: string; weekNumber: number; index: number; brand: Brand }): PlannedPost {
  const { draft, brand } = options;
  const format = formatFor(options.weekNumber, options.index);
  const base = { id: options.id, date: options.date, painPoint: draft.painPoint, format, headline: draft.headline, subline: draft.subline, caption: draft.caption, hashtags: draft.hashtags };
  if (format === 'type') return { ...base, mode: 'template' };
  return { ...base, mode: 'ai', imagePrompt: creativePrompt(format, draft.visual, brand) };
}

/** Turns back a draft the poster cannot be made from, so the model is asked again with the reason. */
export function validateDraft(draft: DraftPost, position: number): void {
  if (typeof draft.visual !== 'string' || !draft.visual.trim()) throw new Error(`post ${position} needs a "visual"`);
  if (typeof draft.visualLink !== 'string' || !draft.visualLink.trim()) throw new Error(`post ${position} needs a "visualLink": how the picture connects to the headline`);
  // 45 is the target given to the model; allow some slack before forcing a retry.
  if (typeof draft.headline === 'string' && draft.headline.replaceAll('|', '').length > 60) {
    throw new Error(`post ${position} headline is too long; keep it under 45 characters`);
  }
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
  log?: (message: string) => void;
}): Promise<WeekPlan> {
  const { brand, schedule } = options;
  const dates = scheduleDates(schedule);
  const week = String(options.weekNumber).padStart(2, '0');
  const usedPainPoints = [...options.usedPainPoints];
  const posts: WeekPlan['posts'] = [];

  for (let offset = 0; offset < dates.length; offset += POSTS_PER_REQUEST) {
    const chunkDates = dates.slice(offset, offset + POSTS_PER_REQUEST);
    options.log?.(`writing posts ${offset + 1}-${offset + chunkDates.length} of ${dates.length}`);
    const chunk = await chatJson({
      ai: options.ai,
      system: SYSTEM_PROMPT,
      user: userPrompt(brand, chunkDates.length, usedPainPoints),
      parse: (value) => {
        const drafts = (value as { posts?: unknown }).posts;
        if (!Array.isArray(drafts) || drafts.length !== chunkDates.length) {
          throw new Error(`"posts" must contain exactly ${chunkDates.length} items`);
        }
        const plan = {
          brand: options.brandSlug,
          timezone: schedule.utcOffset,
          posts: (drafts as DraftPost[]).map((d, i) => {
            validateDraft(d, i + 1);
            return buildPost({ draft: d, id: `w${week}-d${offset + i + 1}`, date: chunkDates[i] as string, weekNumber: options.weekNumber, index: offset + i, brand });
          }),
        };
        return parseWeekPlan(plan, `week-${week}`).posts;
      },
    });
    posts.push(...chunk);
    usedPainPoints.push(...chunk.map((p) => p.painPoint));
  }

  return parseWeekPlan({ brand: options.brandSlug, timezone: schedule.utcOffset, posts }, `week-${week}`);
}
