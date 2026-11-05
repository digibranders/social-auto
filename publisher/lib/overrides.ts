import type { ScheduledPost } from './schedule.js';
import { mergeViews, parseStoredVariants, toVariants, type StoredVariants } from './variants.js';

/** Instagram's own limits, plus a smaller image cap: Vercel functions accept request bodies up to 4.5 MB. */
export const MAX_CAPTION_LENGTH = 2200;
export const MAX_HASHTAGS = 30;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Edits made in the dashboard to a post that has not gone out yet. Anything missing means "as originally planned". */
export interface PostOverride {
  caption?: string;
  /** Random key of the replacement picture; the picture is served from /api/edited-image?k=<key>. */
  imageKey?: string;
  /** The post is skipped: it stays on the calendar but is never sent. Undone by unskipping, while its time is still ahead. */
  skipped?: boolean;
  /** Own caption and/or picture for single platforms (see variants.ts). */
  variants?: StoredVariants;
  /** A planned post moved to another day or given another time: ISO 8601 with offset. Hand-made posts are moved in their own file instead. */
  date?: string;
  updatedAt: string;
}

export type OverrideMap = Record<string, PostOverride>;

export class EditError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'EditError';
    this.status = status;
  }
}

const HASHTAG = /#[\p{L}\p{N}_]+/gu;
const IMAGE_KEY = /^[0-9a-f]{32}$/;

export function isImageKey(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_KEY.test(value);
}

export function imagePathFor(key: string): string {
  return `/api/edited-image?k=${key}`;
}

/** The caption as it will be posted: trimmed, within Instagram's limits. */
export function validateCaption(raw: unknown): string {
  if (typeof raw !== 'string') throw new EditError('caption must be text');
  const caption = raw.replace(/\r\n/g, '\n').trim();
  if (!caption) throw new EditError('caption cannot be empty');
  if (caption.length > MAX_CAPTION_LENGTH) {
    throw new EditError(`caption is ${caption.length} characters; Instagram allows ${MAX_CAPTION_LENGTH}`);
  }
  const hashtags = caption.match(HASHTAG)?.length ?? 0;
  if (hashtags > MAX_HASHTAGS) throw new EditError(`caption has ${hashtags} hashtags; Instagram allows ${MAX_HASHTAGS}`);
  return caption;
}

/**
 * Checks that the bytes are a JPEG with a square picture (the planned posters are square) and
 * returns its size. Reads the file's own header, never trusting a declared content type.
 */
export function validateJpeg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length === 0) throw new EditError('no picture was sent');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new EditError(`picture is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB`, 413);
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new EditError('picture must be a JPG file');

  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) throw new EditError('picture is not a valid JPG file');
    const marker = bytes[i + 1] as number;
    if (marker === 0xff) {
      i += 1; // padding
      continue;
    }
    // Start-of-frame markers (baseline, extended, progressive...) carry the picture size.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const length = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    if (isFrame) {
      const height = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number);
      const width = ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number);
      if (width < 320 || height < 320) throw new EditError(`picture is ${width}x${height}; it must be at least 320x320`);
      if (width !== height) throw new EditError(`picture is ${width}x${height}; it must be square, like the other posters`);
      if (width > 4096) throw new EditError(`picture is ${width}x${height}; it must be at most 4096x4096`);
      return { width, height };
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan without a frame header
    i += 2 + length;
  }
  throw new EditError('picture is not a valid JPG file');
}

export function parseOverrides(raw: unknown): OverrideMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('overrides must be an object');
  const result: OverrideMap = {};
  for (const [id, value] of Object.entries(raw)) {
    const o = value as Record<string, unknown>;
    if (typeof o !== 'object' || o === null || typeof o['updatedAt'] !== 'string') {
      throw new Error(`overrides["${id}"] is malformed`);
    }
    if (o['caption'] !== undefined && typeof o['caption'] !== 'string') throw new Error(`overrides["${id}"].caption is malformed`);
    if (o['imageKey'] !== undefined && !isImageKey(o['imageKey'])) throw new Error(`overrides["${id}"].imageKey is malformed`);
    if (o['date'] !== undefined && (typeof o['date'] !== 'string' || Number.isNaN(Date.parse(o['date'])))) throw new Error(`overrides["${id}"].date is malformed`);
    if (o['skipped'] !== undefined && typeof o['skipped'] !== 'boolean') throw new Error(`overrides["${id}"].skipped is malformed`);
    const variants = parseStoredVariants(o['variants']);
    const parsed = { ...(o as unknown as PostOverride) };
    if (variants) parsed.variants = variants;
    else delete parsed.variants;
    result[id] = parsed;
  }
  return result;
}

export type EditedPost = ScheduledPost & { edited: boolean };

/** The posts as they will actually be sent: planned posts with the dashboard edits applied on top, and the ones skipped marked. */
export function applyOverrides(posts: ScheduledPost[], overrides: OverrideMap): EditedPost[] {
  return posts.map((post) => {
    const o = overrides[post.id];
    if (!o) return { ...post, edited: false };
    const moved = o.date === undefined ? {} : { date: o.date, ownTime: true };
    const skipped = o.skipped === true ? { skipped: true } : {};
    if (o.caption === undefined && o.imageKey === undefined && o.variants === undefined) return { ...post, ...moved, ...skipped, edited: false };
    const variants = mergeViews(post.variants, toVariants(o.variants));
    return {
      ...post,
      ...moved,
      ...skipped,
      caption: o.caption ?? post.caption,
      image: o.imageKey ? imagePathFor(o.imageKey) : post.image,
      ...(variants ? { variants } : {}),
      edited: true,
    };
  });
}

/** A post can be changed only while its time is still ahead: after that it is due, published, or missed. */
export function isEditable(post: ScheduledPost, now: number): boolean {
  return Date.parse(post.date) > now;
}
