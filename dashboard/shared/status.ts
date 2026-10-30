/**
 * The status feed's shape, shared by the server (which validates what the publisher sends) and the
 * browser (which validates what the server sends). Keep in step with publisher/lib/schedule.ts.
 */

export type PostState = 'published' | 'scheduled' | 'due' | 'missed' | 'unknown';
export type Platform = 'instagram' | 'facebook' | 'linkedin';

export const POST_STATES: readonly PostState[] = ['published', 'scheduled', 'due', 'missed', 'unknown'];
export const PLATFORMS: readonly Platform[] = ['instagram', 'facebook', 'linkedin'];

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
  crossposts: Crosspost[];
}

export interface Crosspost {
  platform: Platform;
  account: string;
  state: PostState;
  permalink: string | null;
}

export interface ChannelHealth {
  platform: Platform;
  account: string | null;
  /** Profile picture link (temporary), if the platform gave one. */
  avatar: string | null;
  /** The clients whose posts go out through this channel. */
  brands: string[];
  ok: boolean;
  error?: string;
}

export interface StatusResponse {
  generatedAt: string;
  channels: ChannelHealth[];
  posts: StatusPost[];
  runway: Array<{ brand: string; postsLeft: number }>;
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
    return {
      platform: oneOf(text(channel, 'platform', where), PLATFORMS, `${where}.platform`),
      account: textOrNull(channel, 'account', where),
      avatar: textOrNull(channel, 'avatar', where),
      brands: list(channel['brands'], `${where}.brands`).map((brand, j) => {
        if (typeof brand !== 'string') throw new StatusParseError(`${where}.brands[${j}] must be a string`);
        return brand;
      }),
      ok: channel['ok'] === true,
      ...(error ? { error } : {}),
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
    return { brand: text(entry, 'brand', where), postsLeft };
  });

  return { generatedAt, channels, posts, runway };
}
