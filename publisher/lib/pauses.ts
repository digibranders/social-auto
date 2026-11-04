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
}

export type PauseScope = 'all' | 'brand' | 'channel';

export const NO_PAUSES: PauseFile = { all: false, brands: [], channels: [] };

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
  return { all: file['all'] === true, brands: ids(file['brands'], 'brands', isBrandSlug), channels: ids(file['channels'], 'channels', isChannelId) };
}

/** Whether a client's posts are all held, by a pause on everything or on that client. */
export const brandIsPaused = (pauses: PauseFile, brand: string): boolean => pauses.all || pauses.brands.includes(brand);

/** Whether a post of this client is held on this channel: the widest pause that covers it wins. */
export const isPaused = (pauses: PauseFile, brand: string, channelId: string): boolean => brandIsPaused(pauses, brand) || pauses.channels.includes(channelId);

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
