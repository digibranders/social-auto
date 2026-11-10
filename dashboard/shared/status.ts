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
  /** Platforms with a caption and/or picture of their own; the main caption and picture stand for the others. */
  variants: Partial<Record<Platform, { caption?: string; image?: string }>>;
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

export type CostPurpose = 'picture' | 'writing' | 'profile';
export const COST_PURPOSES: readonly CostPurpose[] = ['picture', 'writing', 'profile'];

/** What the AI cost for one client and one thing, in dollars (estimated). `post` is null for reading the website. */
export interface CostEntry {
  brand: string;
  post: string | null;
  purpose: CostPurpose;
  /** When the latest of these calls was made. */
  at: string;
  usd: number;
}

/** What to post, where and for how long, as a client carries it (see publisher/lib/clients.ts). */
export interface ClientPlanData {
  platforms: string[];
  startDate: string;
  durationDays: number;
  postsPerWeek?: number;
  weekdays?: string[];
  time: string;
  utcOffset: string;
}

/** The plans of a client, skipping any entry that is not a plan. */
function plansOf(value: unknown): ClientPlanData[] {
  return Array.isArray(value) ? value.flatMap((v) => planData(v) ?? []) : [];
}

function planData(value: unknown): ClientPlanData | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const p = value as Record<string, unknown>;
  if (!Array.isArray(p['platforms']) || !p['platforms'].every((x) => typeof x === 'string') || typeof p['startDate'] !== 'string' || typeof p['durationDays'] !== 'number' || typeof p['time'] !== 'string' || typeof p['utcOffset'] !== 'string') return undefined;
  return { platforms: p['platforms'] as string[], startDate: p['startDate'], durationDays: p['durationDays'], time: p['time'], utcOffset: p['utcOffset'], ...(typeof p['postsPerWeek'] === 'number' ? { postsPerWeek: p['postsPerWeek'] } : {}), ...(Array.isArray(p['weekdays']) ? { weekdays: (p['weekdays'] as unknown[]).filter((d): d is string => typeof d === 'string') } : {}) };
}

export interface StatusResponse {
  generatedAt: string;
  pauses: Pauses;
  channels: ChannelHealth[];
  posts: StatusPost[];
  /** `added`: a client added in the dashboard, with no planned posts yet; it can be removed. */
  runway: Array<{ brand: string; postsLeft: number; added?: true; name?: string; product?: string; website?: string; plans?: ClientPlanData[]; weeklyLimit?: number; requireAuthenticLogo?: true; approvalMode?: 'manual' | 'auto' }>;
  costs: CostEntry[];
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

function variantsOf(raw: unknown): StatusPost['variants'] {
  const result: StatusPost['variants'] = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result;
  for (const platform of PLATFORMS) {
    const value = (raw as Record<string, unknown>)[platform];
    if (typeof value !== 'object' || value === null) continue;
    const { caption, image } = value as Record<string, unknown>;
    const own = { ...(typeof caption === 'string' ? { caption } : {}), ...(typeof image === 'string' ? { image } : {}) };
    if (Object.keys(own).length > 0) result[platform] = own;
  }
  return result;
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
      variants: variantsOf(post['variants']),
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
    return { brand: text(entry, 'brand', where), postsLeft, ...(entry['added'] === true ? { added: true as const } : {}), ...(typeof entry['name'] === 'string' ? { name: entry['name'] } : {}), ...(typeof entry['product'] === 'string' ? { product: entry['product'] } : {}), ...(typeof entry['website'] === 'string' ? { website: entry['website'] } : {}), ...(plansOf(entry['plans']).length > 0 ? { plans: plansOf(entry['plans']) } : {}), ...(entry['requireAuthenticLogo'] === true ? { requireAuthenticLogo: true as const } : {}), ...(entry['approvalMode'] === 'auto' ? { approvalMode: 'auto' as const } : entry['approvalMode'] === 'manual' ? { approvalMode: 'manual' as const } : {}), ...(typeof entry['weeklyLimit'] === 'number' && Number.isInteger(entry['weeklyLimit']) && entry['weeklyLimit'] >= 1 && entry['weeklyLimit'] <= 7 ? { weeklyLimit: entry['weeklyLimit'] } : {}) };
  });

  const pauseRoot = root['pauses'] === undefined ? {} : record(root['pauses'], 'status.pauses');
  const names = (key: string): string[] => (Array.isArray(pauseRoot[key]) ? (pauseRoot[key] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
  const pauses: Pauses = { all: pauseRoot['all'] === true, brands: names('brands'), channels: names('channels') };

  
  const costs = list(root['costs'] ?? [], 'status.costs').map((item, i): CostEntry => {
    const where = `costs[${i}]`;
    const entry = record(item, where);
    const at = text(entry, 'at', where);
    if (Number.isNaN(Date.parse(at))) throw new StatusParseError(`${where}.at is not a date`);
    const usd = entry['usd'];
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) throw new StatusParseError(`${where}.usd must be zero or more`);
    return { brand: text(entry, 'brand', where), post: textOrNull(entry, 'post', where), purpose: oneOf(text(entry, 'purpose', where), COST_PURPOSES, `${where}.purpose`), at, usd };
  });

  return { generatedAt, pauses, channels, posts, runway, costs };
}
