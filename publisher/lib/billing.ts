/**
 * The end of a customer's paid period, as a product sees it. The date itself lives in the pause file (pauses.ts, `billing`): a brand's posts go out until the day
 * before the billing date and are held from then on, whatever was drawn or approved. Setting a later date or clearing it lets posts go out again (a day that has
 * already passed while it was held is skipped, never sent late).
 */
import { billingOf, billingState, lastPostingDay, type PauseFile } from './pauses.js';
import type { Notice } from './workspace-notices.js';

export interface BillingView {
  endDate: string | null;
  lastPostingDay: string | null;
  state: 'none' | 'ending' | 'ended';
}

export function billingView(pauses: PauseFile, brand: string, nowMs: number): BillingView {
  const entry = billingOf(pauses, brand);
  return { endDate: entry?.endDate ?? null, lastPostingDay: entry ? lastPostingDay(entry.endDate) : null, state: billingState(pauses, brand, nowMs) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-12-10" as "10 Dec". */
const shortDay = (day: string): string => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`;

/** What the customer should be told: that posting stops on a day, or that it has stopped. */
export function planNotices(view: BillingView): Notice[] {
  if (view.state === 'ending' && view.endDate) return [{ code: 'PLAN_ENDING', message: `Posting stops on ${shortDay(view.endDate)}. Posts for earlier days go out as planned.` }];
  if (view.state === 'ended') return [{ code: 'PLAN_ENDED', message: 'Posting stopped because the plan ended. Keep or renew the plan and posts will go out again from the next day.' }];
  return [];
}
