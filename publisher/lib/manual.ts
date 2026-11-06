import { randomBytes } from 'node:crypto';
import { EditError, imagePathFor, isImageKey, validateCaption, type OverrideMap } from './overrides.js';
import type { ScheduledPost } from './schedule.js';
import { applyVariantPatch, parseStoredVariants, toVariants, validateVariants, variantKeys, type StoredVariants } from './variants.js';

/** A post written by hand in the dashboard, kept apart from the posts the content job plans. */
export interface ManualPost {
  id: string;
  brand: string;
  /** ISO 8601 with offset: when it goes out (10:00 by default, or the time chosen for it). */
  date: string;
  caption: string;
  /** Key of the picture in the store, served from /api/edited-image?k=<key>. */
  imageKey: string;
  /** "instagram" and/or channel ids. Never empty. */
  channels: string[];
  /** Own caption and/or picture for single platforms; a platform without one uses the main caption and picture. */
  variants?: StoredVariants;
  createdAt: string;
}

export interface ManualFile {
  posts: ManualPost[];
}

export const MAX_MANUAL_POSTS = 300;
/** A hand-made post goes out at the daily run's time unless it is given a time of its own. */
export const DEFAULT_POST_TIME = '10:00';
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
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
    const variants = parseStoredVariants(p['variants']);
    const post = { ...(p as unknown as ManualPost) };
    if (variants) post.variants = variants;
    else delete post.variants;
    return post;
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
    ...(toVariants(post.variants) ? { variants: toVariants(post.variants) } : {}),
  };
}

/**
 * The moment a post on this day (YYYY-MM-DD) goes out: `time` ("HH:MM", India time) or the daily run's 10:00. Must be
 * ahead of now and within 90 days. A post with its own time is sent by the frequent run, within minutes of it.
 */
export function postDateFor(day: unknown, now: number, time?: unknown): string {
  if (typeof day !== 'string' || !DAY.test(day)) throw new EditError('choose a day');
  if (time !== undefined && (typeof time !== 'string' || !TIME.test(time))) throw new EditError('choose a time like 12:05');
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const real = new Date(Date.UTC(year, month - 1, dayOfMonth));
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== dayOfMonth) throw new EditError('that day does not exist');
  const date = `${day}T${time ?? DEFAULT_POST_TIME}:00+05:30`;
  const at = Date.parse(date);
  if (at <= now) {
    throw new EditError(time === undefined ? 'that day has already passed. The next daily run is 10:00 in the morning.' : 'that time has already passed. Choose a later time.');
  }
  if (at - now > MAX_DAYS_AHEAD * DAY_MS) throw new EditError(`choose a day within the next ${MAX_DAYS_AHEAD} days`);
  return date;
}

export interface NewManualPost {
  brand: string;
  day: unknown;
  /** "HH:MM" India time; left out means the daily run's 10:00. */
  time?: unknown;
  caption: unknown;
  imageKey: unknown;
  channels: unknown;
  variants?: unknown;
}

/**
 * Checks a new hand-made post and returns it. `allowedChannels` are the ids connected for the client, plus
 * "instagram"; picking anything else, or nothing, is refused.
 */
export function buildManualPost(input: NewManualPost, allowedChannels: readonly string[], now: number): ManualPost {
  const caption = validateCaption(input.caption);
  const date = postDateFor(input.day, now, input.time);
  if (!isImageKey(input.imageKey)) throw new EditError('add a picture first');
  if (!Array.isArray(input.channels) || input.channels.some((c) => typeof c !== 'string')) throw new EditError('choose where to post');
  const channels = [...new Set(input.channels as string[])];
  if (channels.length === 0) throw new EditError('choose at least one channel');
  const unknown = channels.find((c) => !allowedChannels.includes(c));
  if (unknown) throw new EditError('one of the chosen channels is not connected for this client');
  const variants = input.variants === undefined ? {} : validateVariants(input.variants);
  return {
    id: `manual-${randomBytes(6).toString('hex')}`,
    brand: input.brand,
    date,
    caption,
    imageKey: input.imageKey,
    channels,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    createdAt: new Date(now).toISOString(),
  };
}

export interface ManualChanges {
  day?: unknown;
  /** "HH:MM" India time. */
  time?: unknown;
  caption?: unknown;
  imageKey?: unknown;
  channels?: unknown;
  /** A change to some platforms' own versions (see applyVariantPatch): left out stays, null goes back to the main ones. */
  variants?: unknown;
}

/**
 * The post with the given changes made; anything left out stays as it is. A new day, picture or caption is checked
 * like a new post's; new channels must be among `allowedChannels`. Throws EditError when nothing is changed or a
 * change is not allowed.
 */
export function editManualPost(post: ManualPost, changes: ManualChanges, allowedChannels: readonly string[], now: number): ManualPost {
  if (changes.day === undefined && changes.time === undefined && changes.caption === undefined && changes.imageKey === undefined && changes.channels === undefined && changes.variants === undefined) {
    throw new EditError('nothing to change');
  }
  const edited: ManualPost = { ...post, channels: [...post.channels] };
  const currentDay = post.date.slice(0, 10);
  const currentTime = post.date.slice(11, 16);
  if ((changes.day !== undefined && changes.day !== currentDay) || (changes.time !== undefined && changes.time !== currentTime)) {
    edited.date = postDateFor(changes.day ?? currentDay, now, changes.time ?? currentTime);
  }
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
  if (changes.variants !== undefined) {
    const variants = applyVariantPatch(post.variants, changes.variants);
    if (Object.keys(variants).length > 0) edited.variants = variants;
    else delete edited.variants;
  }
  return edited;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The moment `now` as a post's date: India time with its offset, to the second. A post sent now is dated now. */
export const dateOfNow = (now: number): string => `${new Date(now + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;

/** Whether a picture is still the picture of one of these posts (as made, or as edited in the dashboard); a product may use one picture for several posts. */
export function pictureInUse(key: string, posts: readonly ManualPost[], overrides: OverrideMap): boolean {
  return posts.some((p) => p.imageKey === key || overrides[p.id]?.imageKey === key || variantKeys(p.variants).includes(key) || variantKeys(overrides[p.id]?.variants).includes(key));
}
