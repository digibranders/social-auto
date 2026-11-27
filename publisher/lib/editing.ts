import { randomBytes } from 'node:crypto';
import { postDateFor } from './manual.js';
import {
  applyOverrides,
  EditError,
  isEditable,
  overridePost,
  platformOfChannel,
  splitId,
  validateCaption,
  validateJpeg,
  type OverrideMap,
  type PostOverride,
} from './overrides.js';
import type { ScheduledPost } from './schedule.js';
import { applyVariantPatch, isPlatform, variantKeys, type Platform } from './variants.js';

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
  | { kind: 'move'; day: unknown; time?: unknown }
  /** One network's own time for a post that goes to several: that network is sent at it, the others at the post's own. */
  | { kind: 'moveNetwork'; network: unknown; day: unknown; time?: unknown }
  | { kind: 'variants'; variants: unknown }
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
  if (!original) throw new EditError('no such post', 404, 'POST_NOT_FOUND');
  const current = overridePost(original, overrides[id]);
  if (!isEditable(current, now)) {
    throw new EditError('this post is already due or published, so it can no longer be changed', 409, 'POST_NOT_EDITABLE');
  }
  return { original, current };
}

/** The post as it was planned, whether or not it is still editable as a whole (one network's own time may still be ahead when the post's own has passed). */
function lookUp(posts: ScheduledPost[], overrides: OverrideMap, id: string, now: number): { original: ScheduledPost; current: ScheduledPost } {
  const original = posts.find((p) => p.id === id);
  if (!original) throw new EditError('no such post', 404, 'POST_NOT_FOUND');
  void now;
  return { original, current: overridePost(original, overrides[id]) };
}

function networkOf(value: unknown): Platform {
  if (!isPlatform(value)) throw new EditError('network must be instagram, facebook, linkedin or google', 400, 'INVALID_REQUEST');
  return value;
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
  // A network's part of a split post is named `<id>~<network>`: a move of it is that network's own time, every other change is the post's.
  const named = splitId(id);
  id = named.base;
  if (action.kind === 'move' && named.network !== null) action = { kind: 'moveNetwork', network: named.network, day: action.day, ...(action.time === undefined ? {} : { time: action.time }) };
  const { original: post } = action.kind === 'moveNetwork' ? lookUp(posts, overrides, id, now) : findEditable(posts, overrides, id, now);
  // A post that goes to one network has one time: moving "its network" is moving the post.
  if (action.kind === 'moveNetwork') {
    const network = networkOf(action.network);
    const networks = new Set((post.channels ?? []).map(platformOfChannel));
    if (!networks.has(network)) throw new EditError('this post does not go to that network', 400, 'INVALID_REQUEST');
    if (networks.size < 2) action = { kind: 'move', day: action.day, ...(action.time === undefined ? {} : { time: action.time }) };
  }
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
    // A planned post takes a new day and may take a new time: a post with a day or time of its own is sent by the frequent run at that time, so
    // several of those can share a day. Only a plain planned post (no time of its own: the daily run sends one a day) holds its day, because a
    // second post on the same day would be dropped by the daily run. Without a time the moved post keeps its planned one.
    const { day: ownDay, time: ownTime } = istParts(post.date);
    const date = postDateFor(action.day, now, action.time === undefined ? ownTime : action.time);
    const { day, time } = istParts(date);
    if (day === ownDay && time === ownTime) {
      next = { ...current, updatedAt };
      delete next.date;
    } else {
      const taken = day !== ownDay && applyOverrides(posts, overrides).some((p) => p.id !== id && p.manual !== true && p.ownTime !== true && (p.brand ?? 'default') === (post.brand ?? 'default') && istParts(p.date).day === day);
      if (taken) throw new EditError('another post is already planned for that day', 409);
      next = { ...current, date, updatedAt };
    }
  } else if (action.kind === 'moveNetwork') {
    if (post.manual) throw new EditError('a post made by hand goes to the networks it was made for at one time', 400);
    const network = networkOf(action.network);
    const mainAt = (current?.date ?? post.date);
    const ownAt = current?.networkDates?.[network] ?? mainAt;
    if (Date.parse(ownAt) <= now) throw new EditError('this post is already due or published on that network, so its time can no longer be changed', 409, 'POST_NOT_EDITABLE');
    const date = postDateFor(action.day, now, action.time === undefined ? istParts(ownAt).time : action.time);
    const dates = { ...current?.networkDates };
    // The same moment as the post's own puts the network back on it.
    if (Date.parse(date) === Date.parse(mainAt)) delete dates[network];
    else dates[network] = date;
    next = { ...current, updatedAt };
    if (Object.keys(dates).length > 0) next.networkDates = dates;
    else delete next.networkDates;
  } else if (action.kind === 'variants') {
    // A change to some platforms' own versions; the others stay as they are, and null puts a platform back on the main ones.
    const variants = applyVariantPatch(current?.variants, action.variants);
    const kept = new Set(variantKeys(variants));
    staleImages.push(...variantKeys(current?.variants).filter((key) => !kept.has(key)));
    next = { ...current, updatedAt };
    if (Object.keys(variants).length > 0) next.variants = variants;
    else delete next.variants;
  } else if (action.kind === 'skip') {
    // A skip by the team is its own decision, whoever skipped the post before.
    next = { ...current, skipped: true, updatedAt };
    delete next.skippedBy;
  } else if (action.kind === 'unskip') {
    next = { ...current, updatedAt };
    delete next.skipped;
    delete next.skippedBy;
  } else {
    // Reverting discards the words and the picture, not the decision to skip the post or the day it was moved to.
    if (current?.imageKey) staleImages.push(current.imageKey);
    staleImages.push(...variantKeys(current?.variants));
    next = current?.skipped || current?.date || current?.networkDates ? { ...(current.skipped ? { skipped: true } : {}), ...(current.date ? { date: current.date } : {}), ...(current.networkDates ? { networkDates: current.networkDates } : {}), updatedAt } : undefined;
  }

  const updated: OverrideMap = { ...overrides };
  if (next && (next.caption !== undefined || next.imageKey !== undefined || next.variants !== undefined || next.skipped === true || next.date !== undefined || next.networkDates !== undefined)) updated[id] = next;
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
  return { post: id, edited: kept !== undefined && (kept.caption !== undefined || kept.imageKey !== undefined || kept.variants !== undefined) };
}
