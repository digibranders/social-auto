import { randomBytes } from 'node:crypto';
import { channelsFor } from './channels.js';
import { buildManualPost, isManualId, MAX_MANUAL_POSTS, toScheduled, type ManualPost } from './manual.js';
import { EditError, isEditable, MAX_IMAGE_BYTES, validateJpeg } from './overrides.js';
import { deleteImage, loadChannels, loadImage, loadManual, loadOverrides, saveImage, saveManual, saveOverrides } from './store.js';

/** Hand-made posts: shared by the dashboard's New post window and the product API. */

async function imageExists(key: string): Promise<boolean> {
  const stream = await loadImage(key);
  await stream?.cancel();
  return stream !== null;
}

/** Checks and stores a picture; answers the key the post will point to. */
export async function storePicture(bytes: Uint8Array): Promise<string> {
  if (bytes.length > MAX_IMAGE_BYTES) throw new EditError('picture is too large', 413);
  validateJpeg(bytes);
  const imageKey = randomBytes(16).toString('hex');
  await saveImage(imageKey, bytes);
  return imageKey;
}

export interface NewPostInput {
  brand: string;
  day: unknown;
  caption: unknown;
  imageKey: unknown;
  /** Channel ids; left out means every channel the client has connected right now. */
  channels?: unknown;
  /** Whether the shared Instagram account may be chosen (only the content job's own clients). */
  allowInstagram: boolean;
}

/** Validates and saves a hand-made post for a client. */
export async function saveNewPost(input: NewPostInput, now: number): Promise<ManualPost> {
  const [{ file: channels }, { file, etag }] = await Promise.all([loadChannels(), loadManual()]);
  if (file.posts.length >= MAX_MANUAL_POSTS) throw new EditError('too many extra posts are stored; delete some first');
  const connected = channelsFor(channels, input.brand).map((c) => c.id);
  const allowed = [...(input.allowInstagram ? ['instagram'] : []), ...connected];
  const chosen = input.channels === undefined ? connected : input.channels;
  const post = buildManualPost({ brand: input.brand, day: input.day, caption: input.caption, imageKey: input.imageKey, channels: chosen }, allowed, now);
  if (!(await imageExists(post.imageKey))) throw new EditError('the picture was not found. Add it again.');
  await saveManual({ posts: [...file.posts, post] }, etag);
  return post;
}

/** Removes a hand-made post that has not gone out yet. `brand`, when given, must be the post's own client. */
export async function removeNewPost(id: unknown, now: number, brand?: string): Promise<void> {
  if (typeof id !== 'string' || !isManualId(id)) throw new EditError('post is required');
  const { file, etag } = await loadManual();
  const post = file.posts.find((p) => p.id === id);
  if (!post || (brand !== undefined && post.brand !== brand)) throw new EditError('no such post', 404);
  if (!isEditable(toScheduled(post), now)) throw new EditError('this post is already due or sent, so it can no longer be deleted', 409);

  await saveManual({ posts: file.posts.filter((p) => p.id !== id) }, etag);
  // Tidy up after the post is gone; a failure here only leaves an unused file behind.
  const { overrides, etag: overridesEtag } = await loadOverrides();
  const edit = overrides[id];
  if (edit) {
    const { [id]: _removed, ...rest } = overrides;
    await saveOverrides(rest, overridesEtag).catch(() => undefined);
    if (edit.imageKey) await deleteImage(edit.imageKey).catch(() => undefined);
  }
  await deleteImage(post.imageKey).catch(() => undefined);
}
