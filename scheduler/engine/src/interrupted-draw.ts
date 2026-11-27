/**
 * A draw the runner lost halfway (a restart, a crash) is marked failed and never silently retried, because it may already have bought pictures. The posts it was drawing
 * were marked "sent to be drawn" before anything was bought, so without a record they stay locked with no picture and read "Drawn" for good. This records each of them that
 * still has no picture as not drawn (NO_PICTURE): the topic opens again, says so, and can be drawn again by the customer or by the weekly catch-up.
 */
import { join } from 'node:path';
import { CopyStage, weekOfPost } from './copy-stage.ts';
import type { Job } from './job-store.ts';
import { NOT_DRAWN_REASON } from './not-drawn.ts';
import { ReviewStore } from './review-store.ts';

/** The ids of the posts the lost draw left locked without a picture, now recorded as not drawn. */
export function recordInterruptedDraw(brandsRoot: string, lost: Pick<Job, 'kind' | 'brand' | 'planFile' | 'postIds' | 'week'>, now: () => Date = () => new Date()): string[] {
  if (lost.kind !== 'draw' || lost.planFile === undefined) return [];
  const brandDir = join(brandsRoot, lost.brand);
  const stage = new CopyStage(brandDir, lost.brand);
  const batch = stage.list().find((b) => b.planFile === lost.planFile);
  if (!batch) return [];
  const withPictures = new Set(new ReviewStore(brandDir, lost.brand, now).list().map((item) => item.version.postId));
  const stuck = batch.posts
    .filter((post) => (lost.postIds && lost.postIds.length > 0 ? lost.postIds.includes(post.postId) : lost.week === undefined || weekOfPost(post) === lost.week))
    .filter((post) => (post.state === 'kept' || post.drawnAt !== undefined) && !withPictures.has(post.postId) && batch.notDrawn?.[post.postId] === undefined)
    .map((post) => post.postId);
  if (stuck.length > 0) stage.setNotDrawn(lost.planFile, Object.fromEntries(stuck.map((id) => [id, { code: 'NO_PICTURE' as const, reason: NOT_DRAWN_REASON.NO_PICTURE }])));
  return stuck;
}
