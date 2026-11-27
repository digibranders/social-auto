import type { ErrorCode } from './api-error.js';
import type { ScheduledPost } from './schedule.js';
import { forPlatform, mergeViews, parseStoredVariants, PLATFORMS, toVariants, type Platform, type StoredVariants } from './variants.js';

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
  /** Set when the skip was made by the customer withdrawing a picture (not by the team): approving again undoes it, a team skip is never undone that way. */
  skippedBy?: 'customer';
  /** Own caption and/or picture for single platforms (see variants.ts). */
  variants?: StoredVariants;
  /** A planned post moved to another day or given another time: ISO 8601 with offset. Hand-made posts are moved in their own file instead. */
  date?: string;
  /**
   * A network's own time for a planned post that goes to more than one network (ISO 8601 with offset). The post is split in two when it is read: the networks with a time
   * of their own are sent at it, the rest at the post's own (see applyOverrides). A network whose time equals the post's own has no entry.
   */
  networkDates?: Partial<Record<Platform, string>>;
  updatedAt: string;
}

export type OverrideMap = Record<string, PostOverride>;

export class EditError extends Error {
  readonly status: number;
  /** What the product API answers as `code` (see api-error.ts); without one the code follows from the status. */
  readonly code: ErrorCode | undefined;
  constructor(message: string, status = 400, code?: ErrorCode) {
    super(message);
    this.name = 'EditError';
    this.status = status;
    this.code = code;
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
  if (typeof raw !== 'string') throw new EditError('caption must be text', 400, 'INVALID_REQUEST');
  const caption = raw.replace(/\r\n/g, '\n').trim();
  if (!caption) throw new EditError('caption cannot be empty', 400, 'CAPTION_REQUIRED');
  if (caption.length > MAX_CAPTION_LENGTH) {
    throw new EditError(`caption is ${caption.length} characters; Instagram allows ${MAX_CAPTION_LENGTH}`, 400, 'CAPTION_TOO_LONG');
  }
  const hashtags = caption.match(HASHTAG)?.length ?? 0;
  if (hashtags > MAX_HASHTAGS) throw new EditError(`caption has ${hashtags} hashtags; Instagram allows ${MAX_HASHTAGS}`, 400, 'TOO_MANY_HASHTAGS');
  return caption;
}

/**
 * Checks that the bytes are a JPEG with a square picture (the planned posters are square) and
 * returns its size. Reads the file's own header, never trusting a declared content type.
 */
export function validateJpeg(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length === 0) throw new EditError('no picture was sent', 400, 'PICTURE_REQUIRED');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new EditError(`picture is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${MAX_IMAGE_BYTES / 1048576} MB`, 413, 'PICTURE_TOO_LARGE');
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new EditError('picture must be a JPG file', 400, 'PICTURE_NOT_JPG');

  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) throw new EditError('picture is not a valid JPG file', 400, 'PICTURE_NOT_JPG');
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
      if (width < 320 || height < 320) throw new EditError(`picture is ${width}x${height}; it must be at least 320x320`, 400, 'PICTURE_TOO_SMALL');
      if (width !== height) throw new EditError(`picture is ${width}x${height}; it must be square, like the other posters`, 400, 'PICTURE_NOT_SQUARE');
      if (width > 4096) throw new EditError(`picture is ${width}x${height}; it must be at most 4096x4096`, 400, 'PICTURE_TOO_LARGE');
      return { width, height };
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan without a frame header
    i += 2 + length;
  }
  throw new EditError('picture is not a valid JPG file', 400, 'PICTURE_NOT_JPG');
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
    if (o['skippedBy'] !== undefined && o['skippedBy'] !== 'customer') throw new Error(`overrides["${id}"].skippedBy is malformed`);
    const variants = parseStoredVariants(o['variants']);
    const networkDates = parseNetworkDates(o['networkDates']);
    const parsed = { ...(o as unknown as PostOverride) };
    if (variants) parsed.variants = variants;
    else delete parsed.variants;
    if (networkDates) parsed.networkDates = networkDates;
    else delete parsed.networkDates;
    result[id] = parsed;
  }
  return result;
}

export type EditedPost = ScheduledPost & { edited: boolean };

/** The separator in the id of a post split by network time: `<post id>~<network>`. */
export const SPLIT_MARK = '~';

/** A post id and, when it names one network's part of a split post, that network. */
export function splitId(id: string): { base: string; network: Platform | null } {
  const at = id.lastIndexOf(SPLIT_MARK);
  if (at < 0) return { base: id, network: null };
  const network = id.slice(at + 1);
  return (PLATFORMS as readonly string[]).includes(network) ? { base: id.slice(0, at), network: network as Platform } : { base: id, network: null };
}

/** The network a channel entry of a post is for: "linkedin:123" and "linkedin" are both LinkedIn. */
export const platformOfChannel = (channel: string): string => (channel.includes(':') ? channel.slice(0, channel.indexOf(':')) : channel);

/** Reads stored network times back from storage; anything malformed is dropped rather than blocking every post. */
export function parseNetworkDates(raw: unknown): Partial<Record<Platform, string>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const result: Partial<Record<Platform, string>> = {};
  for (const platform of PLATFORMS) {
    const value = (raw as Record<string, unknown>)[platform];
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) result[platform] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** One post with its own edits applied (a move, words, a picture, a skip), whole: networks with a time of their own are not split off here. */
export function overridePost(post: ScheduledPost, o: PostOverride | undefined): EditedPost {
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
}

/**
 * A post that goes to several networks and has a time of its own for some of them becomes ordinary posts: the networks on the post's own time stay on it, and each network
 * with a time of its own is a post of its own (`<id>~<network>`, with that network's words and picture, at its time). Everything that reads posts (sending, status, missed
 * alerts, the sent log) then needs to know nothing about this. A post with no network time, or going to one network, is returned as it is.
 */
function splitByNetwork(post: EditedPost, dates: PostOverride['networkDates']): EditedPost[] {
  if (!dates || !post.channels || post.channels.length === 0) return [post];
  let main = post.channels;
  const apart: EditedPost[] = [];
  for (const network of PLATFORMS) {
    const at = dates[network];
    if (at === undefined || Date.parse(at) === Date.parse(post.date)) continue;
    const mine = post.channels.filter((channel) => platformOfChannel(channel) === network);
    if (mine.length === 0) continue;
    main = main.filter((channel) => platformOfChannel(channel) !== network);
    const { variants: _own, ...own } = forPlatform(post, network) as EditedPost;
    apart.push({ ...own, id: `${post.id}${SPLIT_MARK}${network}`, splitOf: post.id, date: at, ownTime: true, channels: mine });
  }
  if (apart.length === 0) return [post];
  return main.length > 0 ? [{ ...post, channels: main }, ...apart] : apart;
}

/** The posts as they will actually be sent: planned posts with the dashboard edits applied on top, the ones skipped marked, and a network with a time of its own split off. */
export function applyOverrides(posts: ScheduledPost[], overrides: OverrideMap): EditedPost[] {
  return posts.flatMap((post) => splitByNetwork(overridePost(post, overrides[post.id]), overrides[post.id]?.networkDates));
}

/** A post can be changed only while its time is still ahead: after that it is due, published, or missed. */
export function isEditable(post: ScheduledPost, now: number): boolean {
  return Date.parse(post.date) > now;
}
