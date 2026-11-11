/**
 * A weekly carousel: three to five slides about one topic, drawn in one shared look, made from the brand's verified facts.
 * This file turns the model's proposal into checked slides; the pictures themselves are drawn by the poster pipeline (ai-creative-pipeline.ts).
 */
import { checkCopy } from './copy-gate.ts';
import { plainHeadline } from './ai-creative.ts';
import { MAX_HEADLINE_CHARS } from './copy-edit.ts';

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
