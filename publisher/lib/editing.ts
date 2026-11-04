import { randomBytes } from 'node:crypto';
import { postDateFor } from './manual.js';
import {
  applyOverrides,
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
  | { kind: 'move'; day: unknown }
  | { kind: 'skip' }
  | { kind: 'unskip' }
  | { kind: 'revert' };

export interface EditResult {
  post: string;
  edited: boolean;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** The day and the time of day (India time) of a moment. */
const istParts = (date: string): { day: string; time: string } => {
  const iso = new Date(Date.parse(date) + IST_OFFSET_MS).toISOString();
  return { day: iso.slice(0, 10), time: iso.slice(11, 16) };
};

/** The post with the dashboard's changes on it, which is what must still be ahead of its time to be edited. */
function findEditable(posts: ScheduledPost[], overrides: OverrideMap, id: string, now: number): { original: ScheduledPost; current: ScheduledPost } {
  const original = posts.find((p) => p.id === id);
  if (!original) throw new EditError('no such post', 404);
  const current = applyOverrides([original], overrides)[0] as ScheduledPost;
  if (!isEditable(current, now)) {
    throw new EditError('this post is already due or published, so it can no longer be changed', 409);
  }
  return { original, current };
}

/** Applies one dashboard edit to a post that has not gone out yet and saves it. */
export async function editPost(
  store: EditStore,
  posts: ScheduledPost[],
  id: string,
  action: EditAction,
  now: number,
): Promise<EditResult> {
  const { overrides, etag } = await store.load();
  const { original: post } = findEditable(posts, overrides, id, now);
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
  } else if (action.kind === 'move') {
    if (post.manual) throw new EditError('a post made by hand is moved in its own file', 400);
    // A planned post keeps its time of day (the daily run sends it) and takes only a new day, which no other planned post of the client has.
    const { day: ownDay, time } = istParts(post.date);
    const date = postDateFor(action.day, now, time);
    const day = istParts(date).day;
    if (day === ownDay) {
      next = { ...current, updatedAt };
      delete next.date;
    } else {
      const taken = applyOverrides(posts, overrides).some((p) => p.id !== id && p.manual !== true && (p.brand ?? 'default') === (post.brand ?? 'default') && istParts(p.date).day === day);
      if (taken) throw new EditError('another post is already planned for that day', 409);
      next = { ...current, date, updatedAt };
    }
  } else if (action.kind === 'skip') {
    next = { ...current, skipped: true, updatedAt };
  } else if (action.kind === 'unskip') {
    next = { ...current, updatedAt };
    delete next.skipped;
  } else {
    // Reverting discards the words and the picture, not the decision to skip the post or the day it was moved to.
    if (current?.imageKey) staleImages.push(current.imageKey);
    next = current?.skipped || current?.date ? { ...(current.skipped ? { skipped: true } : {}), ...(current.date ? { date: current.date } : {}), updatedAt } : undefined;
  }

  const updated: OverrideMap = { ...overrides };
  if (next && (next.caption !== undefined || next.imageKey !== undefined || next.skipped === true || next.date !== undefined)) updated[id] = next;
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
