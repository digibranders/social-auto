/**
 * Per-channel versions of a post. A post has one main caption and picture; a variant replaces either for one platform
 * (Instagram, Facebook, LinkedIn, Google). A platform without a variant, or a variant that leaves a field out, uses the main one.
 */
import { EditError, imagePathFor, isImageKey, validateCaption } from './overrides.js';
import type { ScheduledPost } from './schedule.js';

export const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'google'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const isPlatform = (value: unknown): value is Platform => typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);

/** Stored form: the picture is a key in the picture store. */
export interface StoredVariant {
  caption?: string;
  imageKey?: string;
}
export type StoredVariants = Partial<Record<Platform, StoredVariant>>;

/** Sending form: the picture is a path the platforms can fetch. */
export interface VariantView {
  caption?: string;
  image?: string;
}
export type Variants = Partial<Record<Platform, VariantView>>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks what a person or a product sent as variants and answers the stored form. A variant with neither a caption nor a
 * picture is dropped, which is how "same as main" is expressed. Throws EditError for an unknown platform or a bad value.
 */
export function validateVariants(raw: unknown): StoredVariants {
  if (!isObject(raw)) throw new EditError('variants must be an object keyed by platform', 400, 'INVALID_VARIANTS');
  const result: StoredVariants = {};
  for (const [platform, value] of Object.entries(raw)) {
    if (!isPlatform(platform)) throw new EditError(`"${platform}" is not a platform. Use ${PLATFORMS.join(', ')}.`, 400, 'INVALID_VARIANTS');
    if (value === null) continue;
    if (!isObject(value)) throw new EditError(`variants.${platform} must be an object`, 400, 'INVALID_VARIANTS');
    const variant: StoredVariant = {};
    if (value['caption'] !== undefined && value['caption'] !== null && value['caption'] !== '') variant.caption = validateCaption(value['caption']);
    const pictureId = value['pictureId'] ?? value['imageKey'];
    if (pictureId !== undefined && pictureId !== null && pictureId !== '') {
      if (!isImageKey(pictureId)) throw new EditError(`variants.${platform}.pictureId is not a picture`, 400, 'INVALID_VARIANTS');
      variant.imageKey = pictureId;
    }
    if (variant.caption !== undefined || variant.imageKey !== undefined) result[platform] = variant;
  }
  return result;
}

/** Reads stored variants back from storage; anything malformed is dropped rather than blocking every post. */
export function parseStoredVariants(raw: unknown): StoredVariants | undefined {
  if (!isObject(raw)) return undefined;
  try {
    const parsed = validateVariants(raw);
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function toVariants(stored: StoredVariants | undefined): Variants | undefined {
  if (!stored) return undefined;
  const result: Variants = {};
  for (const platform of PLATFORMS) {
    const v = stored[platform];
    if (!v) continue;
    result[platform] = { ...(v.caption !== undefined ? { caption: v.caption } : {}), ...(v.imageKey !== undefined ? { image: imagePathFor(v.imageKey) } : {}) };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Stored variants merged: `next` wins field by field; an empty result is undefined. */
export function mergeVariants(base: StoredVariants | undefined, next: StoredVariants | undefined): StoredVariants | undefined {
  const result: StoredVariants = {};
  for (const platform of PLATFORMS) {
    const merged = { ...base?.[platform], ...next?.[platform] };
    if (merged.caption !== undefined || merged.imageKey !== undefined) result[platform] = merged;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** The post as it goes to one platform: its own caption and picture where it has them, the main ones otherwise. */
export function forPlatform(post: ScheduledPost, platform: Platform): ScheduledPost {
  const variant = post.variants?.[platform];
  if (!variant) return post;
  return { ...post, caption: variant.caption ?? post.caption, image: variant.image ?? post.image };
}

/** Every picture a stored set of variants points to. */
export const variantKeys = (variants: StoredVariants | undefined): string[] =>
  PLATFORMS.flatMap((p) => (variants?.[p]?.imageKey ? [variants[p]?.imageKey as string] : []));

/** Sending-form variants merged: `next` wins field by field; an empty result is undefined. */
export function mergeViews(base: Variants | undefined, next: Variants | undefined): Variants | undefined {
  const result: Variants = {};
  for (const platform of PLATFORMS) {
    const merged = { ...base?.[platform], ...next?.[platform] };
    if (merged.caption !== undefined || merged.image !== undefined) result[platform] = merged;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * A change to a post's per-channel versions, applied on what it has now. A platform left out stays as it is; `null` puts a
 * platform back on the main caption and picture; inside a platform, a field left out stays and `null` or "" removes it.
 * Answers the whole set after the change (empty means no platform has a version of its own).
 */
export function applyVariantPatch(current: StoredVariants | undefined, raw: unknown): StoredVariants {
  if (!isObject(raw)) throw new EditError('variants must be an object keyed by platform', 400, 'INVALID_VARIANTS');
  const result: StoredVariants = { ...current };
  for (const [platform, value] of Object.entries(raw)) {
    if (!isPlatform(platform)) throw new EditError(`"${platform}" is not a platform. Use ${PLATFORMS.join(', ')}.`, 400, 'INVALID_VARIANTS');
    if (value === null) {
      delete result[platform];
      continue;
    }
    if (!isObject(value)) throw new EditError(`variants.${platform} must be an object or null`, 400, 'INVALID_VARIANTS');
    const next: StoredVariant = { ...result[platform] };
    const caption = value['caption'];
    if (caption === null || caption === '') delete next.caption;
    else if (caption !== undefined) next.caption = validateCaption(caption);
    const pictureId = 'pictureId' in value ? value['pictureId'] : value['imageKey'];
    if (pictureId === null || pictureId === '') delete next.imageKey;
    else if (pictureId !== undefined) {
      if (!isImageKey(pictureId)) throw new EditError(`variants.${platform}.pictureId is not a picture`, 400, 'INVALID_VARIANTS');
      next.imageKey = pictureId;
    }
    if (next.caption !== undefined || next.imageKey !== undefined) result[platform] = next;
    else delete result[platform];
  }
  return result;
}
