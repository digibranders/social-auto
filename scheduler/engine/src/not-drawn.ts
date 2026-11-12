/**
 * A topic the customer kept that got no picture in its week's draw (the headline check dropped it, no picture passed the checks, or a limit stopped it). It stays
 * open: keep, drop and edit work again for it, the week lists it with a fixed code and a plain sentence, and a retry of the week draws only such topics. The system
 * never retries by itself, so the customer decides (and nothing is bought twice).
 */
export type NotDrawnCode = 'HEADLINE_TOO_WEAK' | 'NO_PICTURE' | 'PICTURE_LIMIT_REACHED';

export interface NotDrawn {
  code: NotDrawnCode;
  /** Plain words for the customer. Never the engine's own text. */
  reason: string;
}

export const NOT_DRAWN_REASON: Record<NotDrawnCode, string> = {
  HEADLINE_TOO_WEAK: 'This headline is too weak to draw. Change it or drop it.',
  NO_PICTURE: 'No picture passed our checks this time. Try again, or change the words.',
  PICTURE_LIMIT_REACHED: 'There were no pictures left this week for one of the channels. It can be tried again later.',
};

/** What a post's result in a draw says about why it has no picture. */
export function classifyNotDrawn(result: { status: string; reason?: string }): NotDrawn {
  const reason = result.reason ?? '';
  const code: NotDrawnCode = result.status === 'dropped' && /headline/i.test(reason) ? 'HEADLINE_TOO_WEAK' : result.status === 'budget_stopped' && /pictures for this week|PICTURE_LIMIT/i.test(reason) ? 'PICTURE_LIMIT_REACHED' : 'NO_PICTURE';
  return { code, reason: NOT_DRAWN_REASON[code] };
}
