import { randomBytes } from 'node:crypto';
import { EditError, imagePathFor, isImageKey, validateCaption, type OverrideMap } from './overrides.js';
import type { ScheduledPost } from './schedule.js';

/** A post written by hand in the dashboard, kept apart from the posts the content job plans. */
export interface ManualPost {
  id: string;
  brand: string;
  /** ISO 8601 with offset: the daily run on that day sends it. */
  date: string;
  caption: string;
  /** Key of the picture in the store, served from /api/edited-image?k=<key>. */
  imageKey: string;
  /** "instagram" and/or channel ids. Never empty. */
  channels: string[];
  createdAt: string;
}

export interface ManualFile {
  posts: ManualPost[];
}

export const MAX_MANUAL_POSTS = 300;
/** The daily run happens at this time, so a hand-made post is always set for it. */
export const POST_TIME = '10:00:00+05:30';
const MAX_DAYS_AHEAD = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POST_ID = /^manual-[0-9a-f]{12}$/;

export const isManualId = (id: string): boolean => POST_ID.test(id);

export function parseManualFile(raw: unknown): ManualFile {
  const list = (raw as { posts?: unknown } | null)?.posts;
  if (!Array.isArray(list)) throw new Error('manual file must contain a "posts" array');
  const posts = list.map((p: Record<string, unknown>, i): ManualPost => {
    for (const key of ['id', 'brand', 'date', 'caption', 'imageKey', 'createdAt'] as const) {
      if (typeof p[key] !== 'string' || !p[key]) throw new Error(`manual posts[${i}].${key} must be a non-empty string`);
    }
    if (!isManualId(p['id'] as string)) throw new Error(`manual posts[${i}].id is malformed`);
    if (Number.isNaN(Date.parse(p['date'] as string))) throw new Error(`manual posts[${i}].date is not a date`);
    if (!isImageKey(p['imageKey'])) throw new Error(`manual posts[${i}].imageKey is malformed`);
    const channels = p['channels'];
    if (!Array.isArray(channels) || channels.length === 0 || channels.some((c) => typeof c !== 'string')) {
      throw new Error(`manual posts[${i}].channels must list at least one channel`);
    }
    return p as unknown as ManualPost;
  });
  return { posts };
}

/** A hand-made post in the same shape as a planned one, so everything downstream treats them alike. */
export function toScheduled(post: ManualPost): ScheduledPost {
  return {
    id: post.id,
    brand: post.brand,
    date: post.date,
    caption: post.caption,
    image: imagePathFor(post.imageKey),
    manual: true,
    channels: post.channels,
  };
}

/** The moment the daily run on this day (YYYY-MM-DD) sends a post. Must be ahead of now and within 90 days. */
export function postDateFor(day: unknown, now: number): string {
  if (typeof day !== 'string' || !DAY.test(day)) throw new EditError('choose a day');
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const real = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== dayOfMonth) throw new EditError('that day does not exist');
  const date = `${day}T${POST_TIME}`;
  const at = Date.parse(date);
  if (at <= now) throw new EditError('that day has already passed. The next daily run is 10:00 in the morning.');
  if (at - now > MAX_DAYS_AHEAD * DAY_MS) throw new EditError(`choose a day within the next ${MAX_DAYS_AHEAD} days`);
  return date;
}

export interface NewManualPost {
  brand: string;
  day: unknown;
  caption: unknown;
  imageKey: unknown;
  channels: unknown;
}

/**
 * Checks a new hand-made post and returns it. `allowedChannels` are the ids connected for the client, plus
 * "instagram"; picking anything else, or nothing, is refused.
 */
export function buildManualPost(input: NewManualPost, allowedChannels: readonly string[], now: number): ManualPost {
  const caption = validateCaption(input.caption);
  const date = postDateFor(input.day, now);
  if (!isImageKey(input.imageKey)) throw new EditError('add a picture first');
  if (!Array.isArray(input.channels) || input.channels.some((c) => typeof c !== 'string')) throw new EditError('choose where to post');
  const channels = [...new Set(input.channels as string[])];
  if (channels.length === 0) throw new EditError('choose at least one channel');
  const unknown = channels.find((c) => !allowedChannels.includes(c));
  if (unknown) throw new EditError('one of the chosen channels is not connected for this client');
  return {
    id: `manual-${randomBytes(6).toString('hex')}`,
    brand: input.brand,
    date,
    caption,
    imageKey: input.imageKey,
    channels,
    createdAt: new Date(now).toISOString(),
  };
}

export interface ManualChanges {
  day?: unknown;
  caption?: unknown;
  imageKey?: unknown;
  channels?: unknown;
}

/**
 * The post with the given changes made; anything left out stays as it is. A new day, picture or caption is checked
 * like a new post's; new channels must be among `allowedChannels`. Throws EditError when nothing is changed or a
 * change is not allowed.
 */
export function editManualPost(post: ManualPost, changes: ManualChanges, allowedChannels: readonly string[], now: number): ManualPost {
  if (changes.day === undefined && changes.caption === undefined && changes.imageKey === undefined && changes.channels === undefined) {
    throw new EditError('nothing to change');
  }
  const edited: ManualPost = { ...post, channels: [...post.channels] };
  if (changes.day !== undefined && changes.day !== post.date.slice(0, 10)) edited.date = postDateFor(changes.day, now);
  if (changes.caption !== undefined) edited.caption = validateCaption(changes.caption);
  if (changes.imageKey !== undefined) {
    if (!isImageKey(changes.imageKey)) throw new EditError('add a picture first');
    edited.imageKey = changes.imageKey;
  }
  if (changes.channels !== undefined) {
    if (!Array.isArray(changes.channels) || changes.channels.some((c) => typeof c !== 'string')) throw new EditError('choose where to post');
    const channels = [...new Set(changes.channels as string[])];
    if (channels.length === 0) throw new EditError('choose at least one channel');
    if (channels.some((c) => !allowedChannels.includes(c))) throw new EditError('one of the chosen channels is not connected for this client');
    edited.channels = channels;
  }
  return edited;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The moment `now` as a post's date: India time with its offset, to the second. A post sent now is dated now. */
export const dateOfNow = (now: number): string => `${new Date(now + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;

/** Whether a picture is still the picture of one of these posts (as made, or as edited in the dashboard); a product may use one picture for several posts. */
export function pictureInUse(key: string, posts: readonly ManualPost[], overrides: OverrideMap): boolean {
  return posts.some((p) => p.imageKey === key || overrides[p.id]?.imageKey === key);
}
