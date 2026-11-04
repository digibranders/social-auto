import { randomBytes } from 'node:crypto';
import {
  EditError,
  isEditable,
  validateCaption,
  validateJpeg,
  type OverrideMap,
  type PostOverride,
} from './overrides.js';
import type { ScheduledPost } from './schedule.js';

/** What editing needs from storage; the real one is lib/store.ts, tests use memory. */
export interface EditStore {
  load(): Promise<{ overrides: OverrideMap; etag: string | null }>;
  save(overrides: OverrideMap, etag: string | null): Promise<void>;
  saveImage(key: string, bytes: Uint8Array): Promise<void>;
  deleteImage(key: string): Promise<void>;
}

export type EditAction =
  | { kind: 'caption'; caption: unknown }
  | { kind: 'image'; bytes: Uint8Array }
  | { kind: 'skip' }
  | { kind: 'unskip' }
  | { kind: 'revert' };

export interface EditResult {
  post: string;
  edited: boolean;
}

function findEditable(posts: ScheduledPost[], id: string, now: number): ScheduledPost {
  const post = posts.find((p) => p.id === id);
  if (!post) throw new EditError('no such post', 404);
  if (!isEditable(post, now)) {
    throw new EditError('this post is already due or published, so it can no longer be changed', 409);
  }
  return post;
}

/** Applies one dashboard edit to a post that has not gone out yet and saves it. */
export async function editPost(
  store: EditStore,
  posts: ScheduledPost[],
  id: string,
  action: EditAction,
  now: number,
): Promise<EditResult> {
  const post = findEditable(posts, id, now);
  const { overrides, etag } = await store.load();
  const current: PostOverride | undefined = overrides[id];
  const staleImages: string[] = [];
  const updatedAt = new Date(now).toISOString();
  let next: PostOverride | undefined;

  if (action.kind === 'caption') {
    const caption = validateCaption(action.caption);
    next = { ...current, updatedAt };
    if (caption === post.caption.trim()) delete next.caption;
    else next.caption = caption;
  } else if (action.kind === 'image') {
    validateJpeg(action.bytes);
    const key = randomBytes(16).toString('hex');
    await store.saveImage(key, action.bytes);
    if (current?.imageKey) staleImages.push(current.imageKey);
    next = { ...current, imageKey: key, updatedAt };
  } else if (action.kind === 'skip') {
    next = { ...current, skipped: true, updatedAt };
  } else if (action.kind === 'unskip') {
    next = { ...current, updatedAt };
    delete next.skipped;
  } else {
    // Reverting discards the words and the picture, not the decision to skip the post.
    if (current?.imageKey) staleImages.push(current.imageKey);
    next = current?.skipped ? { skipped: true, updatedAt } : undefined;
  }

  const updated: OverrideMap = { ...overrides };
  if (next && (next.caption !== undefined || next.imageKey !== undefined || next.skipped === true)) updated[id] = next;
  else delete updated[id];

  try {
    await store.save(updated, etag);
  } catch (error) {
    // The new picture was never referenced; do not leave it behind.
    if (action.kind === 'image' && next?.imageKey) await store.deleteImage(next.imageKey).catch(() => undefined);
    throw error;
  }
  for (const key of staleImages) await store.deleteImage(key).catch(() => undefined);
  const kept = updated[id];
  return { post: id, edited: kept !== undefined && (kept.caption !== undefined || kept.imageKey !== undefined) };
}
