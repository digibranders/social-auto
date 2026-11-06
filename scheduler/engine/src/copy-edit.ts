/**
 * The owner changes the writer's headline or caption before anything is drawn. The new words go through the same checks as the writer's own: the claim gate
 * against the facts the post was written from, the writing check, and the length limits the poster can carry. They are then written into the plan file (which
 * is what gets drawn) and into the copy list together, under the list's lock. Nothing is bought here.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCopy } from './copy-gate.ts';
import { checkCopyQuality } from './copy-quality.ts';
import { CopyStage, CopyStageError, PLAN_FILE, type CopyBatch } from './copy-stage.ts';
import { composeCaption } from './content.ts';
import { displayFact, type EvidenceFact } from './evidence.ts';

export const MAX_HEADLINE_CHARS = 60;
export const MAX_CAPTION_CHARS = 1500;

interface RawPost { id?: unknown; headline?: unknown; subline?: unknown; caption?: unknown; hashtags?: unknown; factIds?: unknown }

export function editCopy(input: {
  brandDir: string;
  brand: string;
  planFile: string;
  postId: string;
  headline?: string;
  /** The caption's own words; the hashtags stay as the writer made them. */
  caption?: string;
  by: string;
  /** The facts the brand has, to check the new words against the ones this post was written from. */
  facts: readonly EvidenceFact[];
}): CopyBatch {
  if (!PLAN_FILE.test(input.planFile)) throw new CopyStageError('INVALID', 'that is not a plan file name');
  if (input.headline === undefined && input.caption === undefined) throw new CopyStageError('INVALID', 'give a headline, a caption or both');
  const planPath = join(input.brandDir, input.planFile);
  let raw: { posts?: RawPost[] };
  try {
    raw = JSON.parse(readFileSync(planPath, 'utf8')) as { posts?: RawPost[] };
  } catch {
    throw new CopyStageError('NOT_FOUND', 'no plan for that batch');
  }
  const post = raw.posts?.find((p) => p.id === input.postId);
  if (!post || typeof post.headline !== 'string' || typeof post.caption !== 'string' || !Array.isArray(post.hashtags)) throw new CopyStageError('NOT_FOUND', 'no such post in this plan');

  // Emphasis marks (|) are the writer's way of picking words to stress; the owner types plain words, and the marks of the old headline do not carry over.
  const headline = (input.headline ?? post.headline).replaceAll('|', '').replace(/\s+/g, ' ').trim();
  const caption = (input.caption ?? post.caption).trim();
  if (headline === '') throw new CopyStageError('REJECTED', 'the headline cannot be empty');
  if (headline.length > MAX_HEADLINE_CHARS) throw new CopyStageError('REJECTED', `the headline is ${headline.length} characters; a poster can carry at most ${MAX_HEADLINE_CHARS}`);
  if (caption === '') throw new CopyStageError('REJECTED', 'the caption cannot be empty');
  if (caption.length > MAX_CAPTION_CHARS) throw new CopyStageError('REJECTED', `the caption is ${caption.length} characters; at most ${MAX_CAPTION_CHARS} are allowed`);
  const weak = checkCopyQuality({ headline, caption });
  if (weak) throw new CopyStageError('REJECTED', weak);

  // The claim gate: every checkable statement must be one of the facts this post was written from.
  const ids = Array.isArray(post.factIds) ? (post.factIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  if (ids.length > 0) {
    const evidence = ids.flatMap((id) => { const fact = input.facts.find((f) => f.id === id); return fact ? [displayFact(fact)] : []; });
    const violations = checkCopy({ headline, subline: typeof post.subline === 'string' ? post.subline : '', caption }, evidence);
    if (violations.length > 0) throw new CopyStageError('REJECTED', `the words say something the website does not support: ${violations.map((v) => `${v.field} "${v.sentence.slice(0, 80)}" ${v.reason}`).join('; ')}`);
  }

  const hashtags = (post.hashtags as unknown[]).filter((h): h is string => typeof h === 'string');
  const composed = composeCaption({ caption, hashtags });
  return new CopyStage(input.brandDir, input.brand).edit(input.planFile, input.postId, { headline, caption: composed }, input.by, () => {
    post.headline = headline;
    post.caption = caption;
    const temp = `${planPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`);
    renameSync(temp, planPath);
  });
}
