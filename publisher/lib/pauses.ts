/**
 * Pausing: holding posts back without deleting anything. Three levels, widest first: everything, one client (brand), one channel
 * (one connected account of a client, or "instagram" for the team's own account). A single post is skipped through the post
 * edits (overrides.ts), not here. A paused channel is simply left out of a send: the other channels of the same post still go out.
 */
export interface PauseFile {
  /** Everything is held: every client, every channel. */
  all: boolean;
  /** Clients (brand slugs) whose posts are all held. */
  brands: string[];
  /** Channel ids that are held for whichever client they belong to: "facebook:<id>", "google:<id>", or "instagram" for the team's own account. */
  channels: string[];
  /**
   * A customer's paid period ending: the brand's posts go out until the day BEFORE `endDate` (the billing date), India time, and are held from then on.
   * Absent or empty means no end is set. Set and cleared by the product (POST /api/v1/workspaces/billing), never by the team's pause switches.
   */
  billing?: Record<string, BillingEnd>;
}

/** The billing date a brand's posting ends on (YYYY-MM-DD, the first day with no posting), who said so and when. */
export interface BillingEnd {
  endDate: string;
  setAt: string;
  by: string;
}

export type PauseScope = 'all' | 'brand' | 'channel';

export const NO_PAUSES: PauseFile = { all: false, brands: [], channels: [] };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Whether the text is a real calendar day, such as 2026-12-10. */
export const isRealDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** The moment posting ends: 00:00 India time on the billing date. */
export const billingEndMs = (endDate: string): number => Date.parse(`${endDate}T00:00:00+05:30`);

/** When a check is made: the moment itself, and (when a post is in hand) the moment the post is dated. */
export interface PauseTime {
  nowMs: number;
  postMs?: number;
}

/**
 * Whether this brand's paid period has ended for a post: the post is dated on or after the billing date, or it is being sent on or after it (a post
 * dated the day before that is retried later is held too). Without `time` the moment is now.
 */
export function billingEnded(pauses: PauseFile, brand: string, time: PauseTime = { nowMs: Date.now() }): boolean {
  const entry = pauses.billing?.[brand];
  if (!entry) return false;
  const end = billingEndMs(entry.endDate);
  return time.nowMs >= end || (time.postMs !== undefined && time.postMs >= end);
}

/** The brand's billing end, if one is set. */
export const billingOf = (pauses: PauseFile, brand: string): BillingEnd | null => pauses.billing?.[brand] ?? null;

/** Where the paid period stands: no end set, an end ahead ("ending") or an end that has come ("ended"). */
export function billingState(pauses: PauseFile, brand: string, nowMs: number): 'none' | 'ending' | 'ended' {
  const entry = billingOf(pauses, brand);
  return entry === null ? 'none' : nowMs >= billingEndMs(entry.endDate) ? 'ended' : 'ending';
}

/** The last day posts go out: the day before the billing date. */
export const lastPostingDay = (endDate: string): string => new Date(Date.parse(`${endDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** The file with a brand's billing end set (a date) or cleared (null). */
export function setBilling(file: PauseFile, brand: string, endDate: string | null, by: string, nowIso: string): PauseFile {
  if (!isBrandSlug(brand)) throw new Error('that is not a client name');
  const rest = Object.fromEntries(Object.entries(file.billing ?? {}).filter(([b]) => b !== brand));
  if (endDate === null) return { ...file, billing: rest };
  if (!isRealDay(endDate)) throw new Error('the billing date must be a real day, YYYY-MM-DD');
  return { ...file, billing: { ...rest, [brand]: { endDate, setAt: nowIso, by: by.slice(0, 80) } } };
}

const BRAND = /^[a-z0-9][a-z0-9-]{0,40}$/;
const CHANNEL = /^(?:instagram|(?:facebook|linkedin|google|instagram):[A-Za-z0-9._-]{1,80})$/;
const MAX_ENTRIES = 2000;

export const isBrandSlug = (value: unknown): value is string => typeof value === 'string' && BRAND.test(value);
export const isChannelId = (value: unknown): value is string => typeof value === 'string' && CHANNEL.test(value);

function ids(value: unknown, what: string, valid: (v: unknown) => v is string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES || !value.every(valid)) throw new Error(`pauses.${what} must be a list of valid ids`);
  return [...new Set(value)];
}

export function parsePauses(raw: unknown): PauseFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('pauses must be an object');
  const file = raw as Record<string, unknown>;
  if (file['all'] !== undefined && typeof file['all'] !== 'boolean') throw new Error('pauses.all must be true or false');
  return { all: file['all'] === true, brands: ids(file['brands'], 'brands', isBrandSlug), channels: ids(file['channels'], 'channels', isChannelId), ...billingEntries(file['billing']) };
}

function billingEntries(raw: unknown): { billing?: Record<string, BillingEnd> } {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('pauses.billing must be an object');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES) throw new Error('pauses.billing has too many entries');
  const billing: Record<string, BillingEnd> = {};
  for (const [brand, value] of entries) {
    const entry = value as Record<string, unknown> | null;
    if (!isBrandSlug(brand) || typeof entry !== 'object' || entry === null || !isRealDay(entry['endDate']) || typeof entry['setAt'] !== 'string' || typeof entry['by'] !== 'string') {
      throw new Error(`pauses.billing has a bad entry for ${brand}`);
    }
    billing[brand] = { endDate: entry['endDate'], setAt: entry['setAt'], by: entry['by'] };
  }
  return Object.keys(billing).length > 0 ? { billing } : {};
}

/** Whether a client's posts are all held, by a pause on everything or on that client, or by the end of its paid period (see `billingEnded`). */
export const brandIsPaused = (pauses: PauseFile, brand: string, time?: PauseTime): boolean => pauses.all || pauses.brands.includes(brand) || billingEnded(pauses, brand, time);

/** Whether a post of this client is held on this channel: the widest pause that covers it wins. */
export const isPaused = (pauses: PauseFile, brand: string, channelId: string, time?: PauseTime): boolean => brandIsPaused(pauses, brand, time) || pauses.channels.includes(channelId);

/** The file with one pause turned on or off. `id` is the brand or channel id; it is ignored for "all". */
export function setPause(file: PauseFile, scope: PauseScope, id: unknown, paused: boolean): PauseFile {
  if (scope === 'all') return { ...file, all: paused };
  if (scope === 'brand') {
    if (!isBrandSlug(id)) throw new Error('that is not a client name');
    return { ...file, brands: paused ? [...new Set([...file.brands, id])] : file.brands.filter((b) => b !== id) };
  }
  if (!isChannelId(id)) throw new Error('that is not a channel');
  return { ...file, channels: paused ? [...new Set([...file.channels, id])] : file.channels.filter((c) => c !== id) };
}
