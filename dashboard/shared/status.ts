/**
 * The status feed's shape, shared by the server (which validates what the publisher sends) and the
 * browser (which validates what the server sends). Keep in step with publisher/lib/schedule.ts.
 */

export type PostState = 'published' | 'scheduled' | 'due' | 'missed' | 'unknown' | 'skipped' | 'paused';
export type Platform = 'instagram' | 'facebook' | 'linkedin' | 'google';

export const POST_STATES: readonly PostState[] = ['published', 'scheduled', 'due', 'missed', 'unknown', 'skipped', 'paused'];
export const PLATFORMS: readonly Platform[] = ['instagram', 'facebook', 'linkedin', 'google'];

export interface StatusPost {
  id: string;
  brand: string;
  platform: Platform;
  /** ISO 8601 with offset. */
  date: string;
  caption: string;
  image: string | null;
  state: PostState;
  permalink: string | null;
  publishedAt: string | null;
  mediaUrl: string | null;
  /** The caption or picture was changed in the dashboard after the content job planned it. */
  edited: boolean;
  /** Still ahead of its time and not yet live, so it may be changed. */
  editable: boolean;
  /** Where the post stands on the client's other channels (Facebook Pages). */
  /** Added by hand in the dashboard rather than planned by the content job. */
  manual: boolean;
  /** Where a hand-made post goes ('instagram' and channel ids); null means every connected channel. */
  channels: string[] | null;
  crossposts: Crosspost[];
}

export interface Crosspost {
  platform: Platform;
  account: string;
  state: PostState;
  permalink: string | null;
}

export interface ChannelHealth {
  /** Set for channels that can be disconnected, e.g. "facebook:<page id>" or "google:<location id>". */
  id: string | null;
  platform: Platform;
  account: string | null;
  /** Profile picture link (temporary), if the platform gave one. */
  avatar: string | null;
  /** The clients whose posts go out through this channel. */
  brands: string[];
  /** Held back by a pause on this channel, on its client or on everything: posts are not sent to it. */
  paused: boolean;
  ok: boolean;
  error?: string;
  /** LinkedIn connections end on this date unless the member connects again. */
  expiresAt?: string;
}

/** What is paused: everything, whole clients, and single channels. A single post is skipped instead. */
export interface Pauses {
  all: boolean;
  brands: string[];
  channels: string[];
}

export const NO_PAUSES: Pauses = { all: false, brands: [], channels: [] };

export interface StatusResponse {
  generatedAt: string;
  pauses: Pauses;
  channels: ChannelHealth[];
  posts: StatusPost[];
  /** `added`: a client added in the dashboard, with no planned posts yet; it can be removed. */
  runway: Array<{ brand: string; postsLeft: number; added?: true; name?: string; product?: string; website?: string }>;
}

export class StatusParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusParseError';
  }
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StatusParseError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new StatusParseError(`${where}.${key} must be a string`);
  return value;
}

function textOrNull(obj: Record<string, unknown>, key: string, where: string): string | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new StatusParseError(`${where}.${key} must be a string or null`);
  return value;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new StatusParseError(`${where} must be an array`);
  return value;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], where: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (!found) throw new StatusParseError(`${where} must be one of ${allowed.join(', ')}`);
  return found;
}

export function parseStatus(raw: unknown): StatusResponse {
  const root = record(raw, 'status');
  const generatedAt = text(root, 'generatedAt', 'status');
  if (Number.isNaN(Date.parse(generatedAt))) throw new StatusParseError('status.generatedAt is not a date');

  const channels = list(root['channels'], 'status.channels').map((item, i): ChannelHealth => {
    const where = `channels[${i}]`;
    const channel = record(item, where);
    const error = textOrNull(channel, 'error', where);
    const expiresAt = textOrNull(channel, 'expiresAt', where);
    if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new StatusParseError(`${where}.expiresAt is not a date`);
    return {
      id: textOrNull(channel, 'id', where),
      platform: oneOf(text(channel, 'platform', where), PLATFORMS, `${where}.platform`),
      account: textOrNull(channel, 'account', where),
      avatar: textOrNull(channel, 'avatar', where),
      brands: list(channel['brands'], `${where}.brands`).map((brand, j) => {
        if (typeof brand !== 'string') throw new StatusParseError(`${where}.brands[${j}] must be a string`);
        return brand;
      }),
      paused: channel['paused'] === true,
      ok: channel['ok'] === true,
      ...(error ? { error } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  });

  const posts = list(root['posts'], 'status.posts').map((item, i): StatusPost => {
    const where = `posts[${i}]`;
    const post = record(item, where);
    const date = text(post, 'date', where);
    if (Number.isNaN(Date.parse(date))) throw new StatusParseError(`${where}.date is not a date`);
    return {
      id: text(post, 'id', where),
      brand: text(post, 'brand', where),
      platform: oneOf(text(post, 'platform', where), PLATFORMS, `${where}.platform`),
      date,
      caption: text(post, 'caption', where),
      image: textOrNull(post, 'image', where),
      state: oneOf(text(post, 'state', where), POST_STATES, `${where}.state`),
      permalink: textOrNull(post, 'permalink', where),
      publishedAt: textOrNull(post, 'publishedAt', where),
      mediaUrl: textOrNull(post, 'mediaUrl', where),
      edited: post['edited'] === true,
      editable: post['editable'] === true,
      manual: post['manual'] === true,
      channels: Array.isArray(post['channels']) ? post['channels'].filter((c): c is string => typeof c === 'string') : null,
      crossposts: list(post['crossposts'] ?? [], `${where}.crossposts`).map((entry, j): Crosspost => {
        const w = `${where}.crossposts[${j}]`;
        const c = record(entry, w);
        return {
          platform: oneOf(text(c, 'platform', w), PLATFORMS, `${w}.platform`),
          account: text(c, 'account', w),
          state: oneOf(text(c, 'state', w), POST_STATES, `${w}.state`),
          permalink: textOrNull(c, 'permalink', w),
        };
      }),
    };
  });

  const runway = list(root['runway'], 'status.runway').map((item, i) => {
    const where = `runway[${i}]`;
    const entry = record(item, where);
    const postsLeft = entry['postsLeft'];
    if (typeof postsLeft !== 'number' || !Number.isInteger(postsLeft) || postsLeft < 0) {
      throw new StatusParseError(`${where}.postsLeft must be a whole number`);
    }
    return { brand: text(entry, 'brand', where), postsLeft, ...(entry['added'] === true ? { added: true as const } : {}), ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}), ...(typeof entry['product'] === 'string' ? { product: entry['product'] } : {}), ...(typeof entry['website'] === 'string' ? { website: entry['website'] } : {}) };
  });

  const pauseRoot = root['pauses'] === undefined ? {} : record(root['pauses'], 'status.pauses');
  const names = (key: string): string[] => (Array.isArray(pauseRoot[key]) ? (pauseRoot[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
  const pauses: Pauses = { all: pauseRoot['all'] === true, brands: names('brands'), channels: names('channels') };

  return { generatedAt, pauses, channels, posts, runway };
}
