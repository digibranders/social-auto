/**
 * The two steps of a customer's carousel. First its TOPIC is written (the topic, the words of every slide and the caption for each channel, no picture, about a cent) and the customer
 * decides: keep, drop, or put it back to undecided. Only a kept carousel is drawn (the slides are the part that costs), on her ask; after that it is in review like before (waiting,
 * approved, rejected, blocked). A dropped topic costs nothing and does not use the week's one-carousel allowance. A carousel kept but never drawn simply lapses at its day.
 */
import { changeHistory, readHistory, type HistoryEntry } from './carousel-run.ts';

export type CarouselStatus = 'topic' | 'kept' | 'dropped' | 'drawing' | 'incomplete' | 'pending' | 'approved' | 'rejected' | 'blocked';

export class CarouselStageError extends Error {
  readonly code: 'NOT_FOUND' | 'DAY_PASSED' | 'ALREADY_DRAWN' | 'CONFLICT';
  constructor(code: CarouselStageError['code'], message: string) {
    super(message);
    this.name = 'CarouselStageError';
    this.code = code;
  }
}

/** Whether the slides still have to be drawn: the topic stage of a carousel that was made in two steps. */
export const isTopicStage = (entry: HistoryEntry): boolean => entry.stage === 'topic' || entry.stage === 'kept' || entry.stage === 'dropped';

/** Where a carousel is now. `reviewStatus` is what the review queue says once it is drawn; `drawActive` is whether a drawing job for it is waiting or running. */
export function carouselStatusOf(entry: HistoryEntry, drawActive: boolean, reviewStatus: () => string): CarouselStatus {
  if (entry.stage === 'topic') return 'topic';
  if (entry.stage === 'dropped') return 'dropped';
  if (entry.stage === 'kept') return drawActive ? 'drawing' : 'kept';
  return reviewStatus() as CarouselStatus;
}

/** The headlines and channel words of a carousel that is not drawn yet, as the customer reads them. */
export function topicWords(entry: HistoryEntry): { headlines: string[]; captions: Array<{ network: string; caption: string }> } {
  const plan = entry.plan;
  if (!plan) return { headlines: [], captions: [] };
  return {
    headlines: plan.draft.slides.map((s) => s.headline.replaceAll('|', '')),
    captions: Object.entries(plan.captions).map(([network, caption]) => ({ network, caption })),
  };
}

/** The carousels that count against the week's allowance: a dropped topic does not. */
export const countedCarousels = (entries: readonly HistoryEntry[]): HistoryEntry[] => entries.filter((e) => e.stage !== 'dropped');

/**
 * Keep, drop or put back (`topic`) a carousel's topic. Keeping or putting back needs a day that is tomorrow or later (`today` is the day in India time); dropping is always allowed.
 * Once the slides were drawn, or while they are being drawn, the choice is final.
 */
export function decideCarousel(input: { brandDir: string; id: string; choice: 'kept' | 'dropped' | 'topic'; today: string; drawActive: boolean }): HistoryEntry {
  const entry = readHistory(input.brandDir).find((h) => h.id === input.id);
  if (!entry) throw new CarouselStageError('NOT_FOUND', 'no such carousel');
  if (!isTopicStage(entry) || input.drawActive) throw new CarouselStageError('ALREADY_DRAWN', 'this carousel was already drawn, so its choice is final');
  if (input.choice !== 'dropped' && entry.date !== undefined && entry.date.slice(0, 10) <= input.today) throw new CarouselStageError('DAY_PASSED', 'the day of this carousel is today or has passed');
  const next: HistoryEntry = { ...entry, stage: input.choice };
  changeHistory(input.brandDir, (entries) => entries.map((h) => (h.id === input.id ? next : h)));
  return next;
}

/** Whether a carousel may be drawn now: kept, with a day that is tomorrow or later. */
export function drawProblem(entry: HistoryEntry | undefined, today: string): CarouselStageError | null {
  if (!entry) return new CarouselStageError('NOT_FOUND', 'no such carousel');
  if (entry.stage === 'drawn' || entry.stage === undefined) return new CarouselStageError('ALREADY_DRAWN', 'this carousel was already drawn');
  if (entry.stage !== 'kept') return new CarouselStageError('CONFLICT', 'keep the carousel before drawing it');
  if (entry.date !== undefined && entry.date.slice(0, 10) <= today) return new CarouselStageError('DAY_PASSED', 'the day of this carousel is today or has passed, so it cannot be drawn');
  return null;
}
