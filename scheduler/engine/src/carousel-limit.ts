/**
 * How many carousels a product's customer may have made in a week. A carousel buys 3 to 5 pictures, so it is limited like a draw is: one carousel a week that is still
 * wanted (waiting, approved or posted), and at most two made in the week at all, so a rejected one may be made again once and no more. The week is Monday to Sunday in
 * India time, taken from the day the carousel is for.
 */
import { pictureWeek } from './picture-limit.ts';

export const MAX_CAROUSELS_PER_WEEK = 2;

export interface CarouselMade {
  id: string;
  /** The day the carousel is for, ISO 8601 with the offset. */
  date: string;
  /** Where the owner's review has it: a rejected carousel no longer counts as the week's one. */
  rejected: boolean;
}

export interface CarouselRoom {
  ok: boolean;
  /** Why not, in a plain sentence to show. */
  message?: string;
  /** The day the week starts again (YYYY-MM-DD). */
  restart: string;
}

/** Whether a carousel for `date` may be made, given the ones already made. */
export function carouselRoom(made: readonly CarouselMade[], date: string): CarouselRoom {
  const week = pictureWeek(new Date(date));
  const inWeek = made.filter((c) => {
    const at = Date.parse(c.date);
    return Number.isFinite(at) && at >= week.startMs && at < week.endMs;
  });
  const wanted = inWeek.filter((c) => !c.rejected).length;
  if (wanted >= 1) return { ok: false, message: `A carousel is already made for the week of ${week.from}. You can make another from ${week.restart}, or reject this week's and make one again.`, restart: week.restart };
  if (inWeek.length >= MAX_CAROUSELS_PER_WEEK) return { ok: false, message: `Two carousels were already made for the week of ${week.from}. You can make another from ${week.restart}.`, restart: week.restart };
  return { ok: true, restart: week.restart };
}
