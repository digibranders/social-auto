/**
 * The weekly picture limit of a product's customer: at most a few drawn pictures a week for each channel (5 by default), counted from the paid ledger.
 * The week runs from Monday 00:00 to Sunday 24:00 India time, so it restarts every Monday. Only pictures actually bought count (a try the provider failed
 * does not), and every one counts: the first draw, a redraw and the picture of a network added later. Staff clients are not limited this way.
 */
import { NETWORKS, type Network } from './networks.ts';
import type { PaidCall } from './paid-ledger.ts';

/** 5 for the week's posts and 2 spare, for a redraw or a channel added in the week. */
export const PICTURES_PER_CHANNEL_PER_WEEK = 7;
/** The most a setting may ask for; a number above it is an error, never accepted. */
export const PICTURES_PER_CHANNEL_WEEK_CEILING = 20;

/** The weekly limit per channel for a product's customers: PRODUCT_PICTURES_PER_CHANNEL_WEEK, 5 when it is not set. A bad value is an error, never ignored. */
export function weeklyLimitFromEnv(env: Record<string, string | undefined>): number {
  const raw = env['PRODUCT_PICTURES_PER_CHANNEL_WEEK'];
  if (raw === undefined || raw === '') return PICTURES_PER_CHANNEL_PER_WEEK;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > PICTURES_PER_CHANNEL_WEEK_CEILING) throw new Error(`PRODUCT_PICTURES_PER_CHANNEL_WEEK must be a whole number from 1 to ${PICTURES_PER_CHANNEL_WEEK_CEILING}`);
  return value;
}

const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

export interface PictureWeek {
  /** The Monday the week began, YYYY-MM-DD (India date). */
  from: string;
  /** The Sunday it ends, YYYY-MM-DD. */
  to: string;
  /** The Monday it starts again, YYYY-MM-DD. */
  restart: string;
  startMs: number;
  endMs: number;
}

const indiaDate = (ms: number): string => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The Monday (YYYY-MM-DD) of the week a plain day falls in. A week is Monday to Sunday. */
export function mondayOf(ymd: string): string {
  const day = new Date(`${ymd}T00:00:00Z`);
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday-to-Sunday week (India time) that contains `now`. */
export function pictureWeek(now: Date): PictureWeek {
  const india = new Date(now.getTime() + IST_OFFSET_MS);
  const sinceMonday = (india.getUTCDay() + 6) % 7;
  const startMs = Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate() - sinceMonday) - IST_OFFSET_MS;
  const endMs = startMs + 7 * DAY_MS;
  return { from: indiaDate(startMs), to: indiaDate(endMs - 1), restart: indiaDate(endMs), startMs, endMs };
}

/** The pictures this brand has bought in the week for each channel. A call with no channel (a plain post, a carousel slide) is not counted. */
export function channelPicturesUsed(calls: Iterable<PaidCall>, brandId: string, week: PictureWeek): Record<Network, number> {
  const used = Object.fromEntries(NETWORKS.map((n) => [n, 0])) as Record<Network, number>;
  for (const call of calls) {
    if (call.brandId !== brandId || call.operation !== 'image' || call.status === 'failed' || call.network === undefined) continue;
    if (!(NETWORKS as readonly string[]).includes(call.network)) continue;
    const at = Date.parse(call.createdAt);
    if (at >= week.startMs && at < week.endMs) used[call.network as Network] += 1;
  }
  return used;
}

/** A request that needs more pictures for a channel than the week has left. The review service answers it with 429 and the product shows the sentence as it is. */
export class PictureLimitError extends Error {
  readonly network: Network;
  readonly restart: string;
  constructor(network: Network, restart: string, message: string) {
    super(message);
    this.name = 'PictureLimitError';
    this.network = network;
    this.restart = restart;
  }
}

const NETWORK_NAME: Record<Network, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', google: 'Google' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Monday 17 November" for a YYYY-MM-DD date. */
export function plainDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The sentence the customer is told when a channel has no pictures left, in plain words. */
export function pictureLimitMessage(network: Network, limit: number, used: number, needed: number, restart: string): string {
  const name = NETWORK_NAME[network];
  const left = Math.max(0, limit - used);
  const lead = left === 0
    ? `You have used your ${limit} ${name} pictures for this week.`
    : `You have ${left} of your ${limit} ${name} pictures left this week, and this needs ${needed}.`;
  return `${lead} You can draw more from ${plainDate(restart)}.`;
}
