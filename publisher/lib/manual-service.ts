import { randomBytes } from 'node:crypto';
import { channelsFor } from './channels.js';
import { buildManualPost, dateOfNow, editManualPost, isManualId, pictureInUse, MAX_MANUAL_POSTS, toScheduled, type ManualChanges, type ManualPost } from './manual.js';
import { EditError, isEditable, MAX_IMAGE_BYTES, validateJpeg } from './overrides.js';
import { mergeVariants, variantKeys } from './variants.js';
import { deleteImage, loadChannels, loadImage, loadManual, loadOverrides, saveImage, saveManual, saveOverrides } from './store.js';

/** Hand-made posts: shared by the dashboard's New post window and the product API. */

async function imageExists(key: string): Promise<boolean> {
  const stream = await loadImage(key);
  await stream?.cancel();
  return stream !== null;
}

/** Checks and stores a picture; answers the key the post will point to. */
export async function storePicture(bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new EditError('picture is too large', 413, 'PICTURE_TOO_LARGE');
  validateJpeg(bytes);
  const imageKey = randomBytes(16).toString('hex');
  await saveImage(imageKey, bytes);
  return imageKey;
}

export interface NewPostInput {
  brand: string;
  day: unknown;
  /** "HH:MM" India time; left out means the daily run's 10:00. */
  time?: unknown;
  caption: unknown;
  imageKey: unknown;
  /** Channel ids; left out means every channel the client has connected right now. */
  channels?: unknown;
  /** Own caption and/or picture per platform (see variants.ts). */
  variants?: unknown;
  /** Whether the shared Instagram account may be chosen (only the content job's own clients). */
  allowInstagram: boolean;
}

/** Validates and saves a hand-made post for a client. */
export async function saveNewPost(input: NewPostInput, now: number): Promise<ManualPost> {
  const [{ file: channels }, { file, etag }] = await Promise.all([loadChannels(), loadManual()]);
  if (file.posts.length >= MAX_MANUAL_POSTS) throw new EditError('too many extra posts are stored; delete some first', 400, 'OVER_LIMIT');
  const connected = channelsFor(channels, input.brand).map((c) => c.id);
  const allowed = [...(input.allowInstagram ? ['instagram'] : []), ...connected];
  const chosen = input.channels === undefined ? connected : input.channels;
  const post = buildManualPost({ brand: input.brand, day: input.day, time: input.time, caption: input.caption, imageKey: input.imageKey, channels: chosen, variants: input.variants }, allowed, now);
  for (const key of [post.imageKey, ...variantKeys(post.variants)]) {
    if (!(await imageExists(key))) throw new EditError('the picture was not found. Add it again.', 400, 'PICTURE_NOT_FOUND');
  }
  await saveManual({ posts: [...file.posts, post] }, etag);
  return post;
}

/** Removes a hand-made post that has not gone out yet. `brand`, when given, must be the post's own client. */
export async function removeNewPost(id: unknown, now: number, brand?: string): Promise<void> {
  if (typeof id !== 'string' || !isManualId(id)) throw new EditError('post is required', 400, 'INVALID_REQUEST');
  const { file, etag } = await loadManual();
  const post = file.posts.find((p) => p.id === id);
  if (!post || (brand !== undefined && post.brand !== brand)) throw new EditError('no such post', 404, 'POST_NOT_FOUND');
  if (!isEditable(toScheduled(post), now)) throw new EditError('this post is already due or sent, so it can no longer be deleted', 409, 'POST_NOT_EDITABLE');

  const remaining = file.posts.filter((p) => p.id !== id);
  await saveManual({ posts: remaining }, etag);
  // Tidy up after the post is gone; a failure here only leaves an unused file behind. A picture another post still uses stays.
  const { overrides, etag: overridesEtag } = await loadOverrides();
  const edit = overrides[id];
  const { [id]: _removed, ...rest } = overrides;
  if (edit) await saveOverrides(rest, overridesEtag).catch(() => undefined);
  for (const key of new Set([post.imageKey, edit?.imageKey, ...variantKeys(post.variants), ...variantKeys(edit?.variants)])) {
    if (key !== undefined && !pictureInUse(key, remaining, rest)) await deleteImage(key).catch(() => undefined);
  }
}

/**
 * Changes a hand-made post that has not gone out yet: its day, caption, picture or channels. `brand`, when given,
 * must be the post's own client. A dashboard edit already on the post is folded in first, so it is not lost.
 */
export async function updateNewPost(id: unknown, changes: ManualChanges, now: number, brand?: string): Promise<ManualPost> {
  if (typeof id !== 'string' || !isManualId(id)) throw new EditError('post is required', 400, 'INVALID_REQUEST');
  const [{ file, etag }, { file: channels }, { overrides, etag: overridesEtag }] = await Promise.all([loadManual(), loadChannels(), loadOverrides()]);
  const stored = file.posts.find((p) => p.id === id);
  if (!stored || (brand !== undefined && stored.brand !== brand)) throw new EditError('no such post', 404, 'POST_NOT_FOUND');
  if (!isEditable(toScheduled(stored), now)) throw new EditError('this post is already due or sent, so it can no longer be changed', 409, 'POST_NOT_EDITABLE');

  const dashboardEdit = overrides[id];
  const foldedVariants = mergeVariants(stored.variants, dashboardEdit?.variants);
  const current: ManualPost = { ...stored, caption: dashboardEdit?.caption ?? stored.caption, imageKey: dashboardEdit?.imageKey ?? stored.imageKey, ...(foldedVariants ? { variants: foldedVariants } : {}) };
  const connected = channelsFor(channels, stored.brand).map((c) => c.id);
  const edited = editManualPost(current, changes, connected, now);
  for (const key of new Set([...(edited.imageKey !== current.imageKey ? [edited.imageKey] : []), ...variantKeys(edited.variants).filter((k) => !variantKeys(current.variants).includes(k))])) {
    if (!(await imageExists(key))) throw new EditError('the picture was not found. Add it again.', 400, 'PICTURE_NOT_FOUND');
  }

  const posts = file.posts.map((p) => (p.id === id ? edited : p));
  await saveManual({ posts }, etag);
  // Tidy up after the change is saved; a failure here only leaves an unused file behind. A picture another post still uses stays.
  const { [id]: _folded, ...rest } = overrides;
  if (dashboardEdit) await saveOverrides(rest, overridesEtag).catch(() => undefined);
  for (const key of new Set([stored.imageKey, dashboardEdit?.imageKey, ...variantKeys(stored.variants), ...variantKeys(dashboardEdit?.variants)])) {
    if (key !== undefined && !pictureInUse(key, posts, rest)) await deleteImage(key).catch(() => undefined);
  }
  return edited;
}

/**
 * Dates a hand-made post now, ahead of sending it now, and answers it as it will be sent (a dashboard edit folded in). The post
 * keeps its place in the calendar as today's. `brand`, when given, must be the post's own client.
 */
export async function dateNewPostNow(id: unknown, now: number, brand?: string): Promise<ManualPost> {
  if (typeof id !== 'string' || !isManualId(id)) throw new EditError('post is required', 400, 'INVALID_REQUEST');
  const [{ file, etag }, { overrides }] = await Promise.all([loadManual(), loadOverrides()]);
  const stored = file.posts.find((p) => p.id === id);
  if (!stored || (brand !== undefined && stored.brand !== brand)) throw new EditError('no such post', 404, 'POST_NOT_FOUND');
  const dashboardEdit = overrides[id];
  const sendingVariants = mergeVariants(stored.variants, dashboardEdit?.variants);
  const sending: ManualPost = { ...stored, date: dateOfNow(now), caption: dashboardEdit?.caption ?? stored.caption, imageKey: dashboardEdit?.imageKey ?? stored.imageKey, ...(sendingVariants ? { variants: sendingVariants } : {}) };
  await saveManual({ posts: file.posts.map((p) => (p.id === id ? { ...p, date: sending.date } : p)) }, etag);
  return sending;
}
