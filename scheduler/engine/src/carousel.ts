/**
 * A weekly carousel: three to five slides about one topic, drawn in one shared look, made from the brand's verified facts.
 * This file turns the model's proposal into checked slides; the pictures themselves are drawn by the poster pipeline (ai-creative-pipeline.ts).
 */
import type { AiConfig } from './ai.ts';
import { chatJson } from './llm.ts';
import { checkCopy } from './copy-gate.ts';
import { plainHeadline } from './ai-creative.ts';
import { MAX_HEADLINE_CHARS } from './copy-edit.ts';
import type { PlannedPost } from './content.ts';
import type { PlannedConcept } from './creative-director.ts';

export const MIN_SLIDES = 3;
export const MAX_SLIDES = 5;

export type SlideRole = 'hook' | 'content' | 'closing';

/** A verified fact the slides may be built on. */
export interface CarouselFact {
  id: string;
  text: string;
}

export interface SlideDraft {
  role: SlideRole;
  /** Text inside |pipes| is the accent colour, as in every poster headline. */
  headline: string;
  /** What this slide's picture shows, in words. */
  scene: string;
  /** The verified facts this slide is about (at least one). */
  factIds: string[];
}

export interface CarouselDraft {
  topic: string;
  /** The one visual system every slide shares. */
  style: string;
  /** How every slide's headline is set, the same on every slide. */
  typography: string;
  slides: SlideDraft[];
}

export class CarouselError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CarouselError';
  }
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CarouselError(`${what} must be an object`);
  return value as Record<string, unknown>;
};

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new CarouselError(`the carousel's ${what} must be written out`);
  return value.trim();
};

/** Checks what the model proposed and narrows it. Every problem is named so the model can fix it when it is asked again. */
export function parseCarouselDraft(raw: unknown, facts: readonly CarouselFact[]): CarouselDraft {
  const root = record(raw, 'the carousel');
  const topic = text(root['topic'], 'topic');
  const style = text(root['style'], 'style');
  const typography = text(root['typography'], 'typography');
  const list = root['slides'];
  if (!Array.isArray(list) || list.length < MIN_SLIDES || list.length > MAX_SLIDES) throw new CarouselError(`a carousel has three to five slides, this one has ${Array.isArray(list) ? list.length : 0}`);
  const byId = new Map(facts.map((f) => [f.id, f.text]));
  const seen = new Set<string>();
  const slides = list.map((item, index): SlideDraft => {
    const n = index + 1;
    const slide = record(item, `slide ${n}`);
    const role = slide['role'];
    if (role !== 'hook' && role !== 'content' && role !== 'closing') throw new CarouselError(`slide ${n} has no role (hook, content or closing)`);
    if (index === 0 && role !== 'hook') throw new CarouselError('the first slide must be the hook');
    if (index === list.length - 1 && role !== 'closing') throw new CarouselError('the last slide must be the closing');
    if (index > 0 && role === 'hook') throw new CarouselError(`only the first slide is the hook (slide ${n})`);
    if (index < list.length - 1 && role === 'closing') throw new CarouselError(`only the last slide is the closing (slide ${n})`);
    const headline = text(slide['headline'], `slide ${n} headline`);
    const plain = plainHeadline(headline);
    if (plain.length > MAX_HEADLINE_CHARS) throw new CarouselError(`slide ${n}'s headline has ${plain.length} characters, at most ${MAX_HEADLINE_CHARS}`);
    if (seen.has(plain.toLowerCase())) throw new CarouselError(`slide ${n} has the same headline as an earlier slide`);
    seen.add(plain.toLowerCase());
    const scene = text(slide['scene'], `slide ${n} scene`);
    const ids = slide['factIds'];
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string')) throw new CarouselError(`slide ${n} must name at least one fact`);
    const evidence: string[] = [];
    for (const id of ids as string[]) {
      const fact = byId.get(id);
      if (fact === undefined) throw new CarouselError(`slide ${n} names an unknown fact "${id}"`);
      evidence.push(fact);
    }
    const violations = checkCopy({ headline: plain, subline: '', caption: '' }, evidence);
    if (violations.length > 0) throw new CarouselError(`slide ${n}: "${violations[0]?.sentence}" ${violations[0]?.reason}`);
    return { role, headline, scene, factIds: ids as string[] };
  });
  return { topic, style, typography, slides };
}

const CAROUSEL_SYSTEM = `You plan one weekly social media carousel for a small business, from its verified facts only.
Choose ONE topic that the facts support well, and tell it in three to five slides that are swiped through in order.
- The first slide is the "hook": a short headline that makes a stranger want to swipe. The last slide is the "closing": a plain, friendly call to act. Slides in between are "content", one idea each.
- Every slide names the verified facts it is about (factIds, at least one) and its headline may say only what those facts say. Never add numbers, prices, times, results, guarantees, awards, customers or any claim the named facts do not state.
- Headlines are short (at most 60 characters), plain words, different on every slide. Put the key words of a headline between |pipes| to show them in the accent colour.
- "scene" says what the slide's picture shows: one concrete thing, drawn, with no words, logos, screens with writing, or real people.
- "style" is ONE visual system that every slide shares so they look like one set: the way things are drawn, the background, and the only colours used. Write it as a precise instruction.
- "typography" is how every slide's headline is set, identical on all slides: typeface feel, weight, colour, alignment, position and size.
- Do not choose a topic from the list of topics to avoid.
Answer with JSON only: {"topic": string, "style": string, "typography": string, "slides": [{"role": "hook"|"content"|"closing", "headline": string, "scene": string, "factIds": [string]}]}`;

export interface PlanCarouselInput {
  ai: AiConfig;
  brandName: string;
  /** The brand's verified facts the carousel may use. */
  facts: readonly CarouselFact[];
  /** Topics of recent carousels, so this one is about something else. */
  avoidTopics: readonly string[];
  /** For tests: replaces the network call. */
  fetchFn?: typeof fetch;
}

export const MIN_FACTS = 3;

/** Asks the model for one carousel and returns it checked. The model is told what was wrong and asked once more before this gives up. */
export async function planCarousel(input: PlanCarouselInput): Promise<CarouselDraft> {
  if (input.facts.length < MIN_FACTS) throw new CarouselError(`a carousel needs at least three verified facts, ${input.brandName} has ${input.facts.length}`);
  return chatJson({
    ai: input.ai,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    system: CAROUSEL_SYSTEM,
    user: JSON.stringify({ brand: input.brandName, facts: input.facts.map((f) => ({ id: f.id, text: f.text })), topics_to_avoid: input.avoidTopics }),
    parse: (value) => parseCarouselDraft(value, input.facts),
  });
}

export interface SlidePostOptions {
  /** The slides' post ids are this, then "-s1", "-s2", and so on. */
  idPrefix: string;
  /** All slides of a carousel go out as one post, on one date. */
  date: string;
}

/** One planned post per slide. Slides before the last carry neither the brand's name nor its address (an empty string leaves the line off); the last carries both, as every poster does. Captions are written for the carousel as a whole, not per slide. */
export function slidePosts(draft: CarouselDraft, options: SlidePostOptions): PlannedPost[] {
  return draft.slides.map((slide, index): PlannedPost => ({
    id: `${options.idPrefix}-s${index + 1}`,
    date: options.date,
    painPoint: draft.topic,
    mode: 'ai',
    ...(index < draft.slides.length - 1 ? { signoff: { brandName: '', domain: '' } } : {}),
    headline: slide.headline,
    subline: '',
    pillar: 'carousel',
    factIds: slide.factIds,
    caption: '',
    hashtags: [],
  }));
}

/** The creative director's answer for the slides, written by code: every slide gets the one shared style and typography, plus its own scene. This is what makes the slides read as one set. */
export function slideConcepts(draft: CarouselDraft, posts: readonly PlannedPost[]): PlannedConcept[] {
  return draft.slides.map((slide, index): PlannedConcept => ({
    postId: posts[index]?.id ?? '',
    concept: `ONE CAROUSEL OF ${draft.slides.length} SLIDES; every slide shares exactly the same visual system so they read as one set when swiped: ${draft.style} THIS SLIDE: ${slide.scene}.`,
    people: false,
    factToPicture: `The picture shows ${slide.scene}.`,
    typography: draft.typography,
    replans: 0,
  }));
}
