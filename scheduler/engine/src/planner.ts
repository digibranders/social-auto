/** Writes a week of pain-point posts for a brand with the text model. */
import { parseWeekPlan, type Brand, type WeekPlan } from './content.ts';
import { postDates, type Weekday } from './cadence.ts';
import { chatJson } from './llm.ts';

export const VISUAL_STYLE =
  ', the subject is placed on the right half of the frame, the entire left half of the image is clean empty soft warm cream background,' +
  ' bright warm natural light, premium commercial advertising photography, realistic, shallow depth of field,' +
  ' absolutely no text, no letters, no words, no logos anywhere';

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

const SYSTEM_PROMPT = `You are a senior social media copywriter for small and local businesses.
You write Instagram posts that each address one real customer pain point and show how the brand solves it.
Hard rules:
- Only use facts, prices and offers from the brand profile. Never invent statistics, customer counts, reviews or guarantees.
- No promises of rankings, leads, sales or medical/financial outcomes.
- Plain, warm, confident language. No hype words like "revolutionary" or "game-changer". No emojis in headlines.
Return a single JSON object and nothing else.`;

function userPrompt(brand: Brand, count: number, usedPainPoints: string[]): string {
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
      "visual": "a concrete photographic scene that literally shows this pain point or its metaphor: who (people typical for the audience's country), what objects, what emotion. Max 45 words. No text or screens with words.",
      "caption": "Instagram caption, 450-900 characters: hook line, the problem in the customer's words, how ${brand.name} solves it using real proof points, then the call to action. Use short paragraphs separated by blank lines (\\n\\n).",
      "hashtags": ["6-8 relevant hashtags, each starting with #, last one the brand name"]
    }
  ]
}`;
}

interface DraftPost {
  painPoint: string;
  headline: string;
  subline: string;
  visual: string;
  caption: string;
  hashtags: string[];
}

/** Larger batches make the model repeat itself, so plans are written in chunks. */
export const POSTS_PER_REQUEST = 10;

export async function planWeek(options: {
  apiKey: string;
  brand: Brand;
  brandSlug: string;
  weekNumber: number;
  schedule: PlanSchedule;
  usedPainPoints: string[];
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
      apiKey: options.apiKey,
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
            if (typeof d.visual !== 'string' || !d.visual.trim()) throw new Error(`post ${i + 1} needs a "visual"`);
            // 45 is the target given to the model; allow some slack before forcing a retry.
            if (typeof d.headline === 'string' && d.headline.replaceAll('|', '').length > 60) {
              throw new Error(`post ${i + 1} headline is too long; keep it under 45 characters`);
            }
            return {
              id: `w${week}-d${offset + i + 1}`,
              date: chunkDates[i],
              painPoint: d.painPoint,
              mode: 'ai',
              headline: d.headline,
              subline: d.subline,
              imagePrompt: d.visual.trim().replace(/\.$/, '') + VISUAL_STYLE,
              caption: d.caption,
              hashtags: d.hashtags,
            };
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
