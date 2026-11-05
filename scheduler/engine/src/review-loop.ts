/**
 * Review, repair once, review again, accept or reject: the automatic quality loop that runs after posters are rendered.
 *
 * Every poster is reviewed by the vision reviewer (poster-review.ts). A repair is only one that costs no new picture: leave out the subline,
 * drop the picture for a pictureless layout, move the CTA clear of the picture, or switch to another layout that can reuse the picture already
 * made. A repaired poster is rendered again (so every deterministic measurement runs again), reviewed again, and then either accepted or
 * rejected; there is no second repair. Rejection goes through the same approval record a person uses, with the reason, and an accepted poster
 * stays "pending": the engine never approves for publication. Every step is written to a review report so the loop can be judged.
 */
import { access, copyFile, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { setApproval } from './art-review.ts';
import { writeFileAtomic } from './art-pipeline.ts';
import type { RenderCandidate } from './art-resolve.ts';
import type { PlannedPost, PostArt, WeekPlan } from './content.ts';
import { coversPicture, familyById, layoutRegistry, seatedCleanly } from './layout-registry.ts';
import {
  decideAfterRepair,
  reviewPosters,
  ReviewBudget,
  REVIEW_COST_ESTIMATE_USD,
  type PosterReview,
  type RepairKind,
  type ReviewDecision,
  type ReviewInput,
} from './poster-review.ts';
import { renderArtPost, scenePathFor, type ArtRenderContext, type ArtRenderOverride, type PostRenderRecord } from './render.ts';

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

export type RepairPlan = { override: ArtRenderOverride } | { impossible: string };

/** The brief with its CTA moved to a seat clear of the picture, or undefined when the layout has none. */
function withClearCta(candidate: RenderCandidate): RenderCandidate | undefined {
  const family = familyById(layoutRegistry, candidate.brief.layout);
  const zone = family?.zones[candidate.brief.textZone];
  if (!family || !zone) return undefined;
  const logo = family.logoSlots.find((s) => s.id === candidate.brief.logoSlot);
  const identity = family.identitySlots.find((s) => s.id === candidate.brief.identitySlot);
  if (!logo || !identity) return undefined;
  const seat = family.ctaSlots.find((cta) => !coversPicture(zone, cta) && seatedCleanly(zone, logo, identity, cta));
  if (!seat) return undefined;
  return { ...candidate, brief: { ...candidate.brief, ctaSlot: seat.id }, record: { ...candidate.record, ctaSlot: seat.id } };
}

/**
 * Turns the repairs the reviewer asked for into what the renderer needs, without ever asking for a new picture. Pure: `hasPicture` says whether a
 * candidate's picture already exists on disk, so a layout that would need a different picture is not offered.
 */
export function planRepair(art: PostArt, renderedOptionId: string | undefined, repairs: readonly RepairKind[], hasPicture: (candidate: RenderCandidate) => boolean): RepairPlan {
  const wanted = new Set(repairs);
  const withoutSubline = wanted.has('drop_subline');
  const rendered = art.candidates.find((c) => c.optionId === renderedOptionId) ?? art.candidates[0];
  const usable = (c: RenderCandidate): boolean => !c.imagePrompt || hasPicture(c);
  const override = (candidates: readonly RenderCandidate[]): RepairPlan => ({ override: { candidates, cachedPicturesOnly: true, ...(withoutSubline ? { withoutSubline } : {}) } });

  if (wanted.has('drop_picture')) {
    const pictureless = art.candidates.filter((c) => c.brief.picture.role === 'none');
    return pictureless.length > 0 ? override(pictureless) : { impossible: 'the poster has no pictureless layout to fall back to' };
  }
  if (wanted.has('relayout')) {
    const others = art.candidates.filter((c) => c.optionId !== renderedOptionId && usable(c));
    return others.length > 0 ? override(others) : { impossible: 'no other layout can reuse the picture that was already made' };
  }
  if (wanted.has('move_cta')) {
    const moved = rendered && withClearCta(rendered);
    if (moved) return override([moved]);
    const others = art.candidates.filter((c) => c.optionId !== renderedOptionId && usable(c));
    return others.length > 0 ? override(others) : { impossible: 'the CTA has no seat clear of the picture and no other layout can reuse it' };
  }
  return rendered ? override([rendered]) : { impossible: 'the poster has no art direction to render again' };
}

export interface PostReviewReport {
  postId: string;
  first?: Pick<PosterReview, 'observed' | 'scores' | 'defects'> & { decision: ReviewDecision };
  repairs?: RepairKind[];
  repairFailure?: string;
  second?: Pick<PosterReview, 'observed' | 'scores' | 'defects'> & { decision: ReviewDecision };
  /** accepted: left pending for the owner; rejected: recorded as rejected by the loop; unreviewed: the review could not run, so nothing was decided. */
  final: 'accepted' | 'accepted_after_repair' | 'rejected' | 'unreviewed';
  reason?: string;
}

export interface ReviewLoopReport {
  at: string;
  budgetUsd: number;
  spentUsd: number;
  posts: PostReviewReport[];
}

export interface ReviewLoopOptions {
  ai: AiConfig;
  ctx: ArtRenderContext;
  plan: WeekPlan;
  planFile: string;
  /** Source text of a fact id; the first of a post's fact ids is the one it was written from. */
  factText: (id: string) => string | undefined;
  /** What review and repair may spend for the whole batch. */
  budgetUsd: number;
  records: readonly PostRenderRecord[];
  log?: (message: string) => void;
  /** For tests. */
  fetchFn?: typeof fetch;
}

const plain = (marked: string): string => marked.replaceAll('|', '');

function inputFor(ctx: ArtRenderContext, post: PlannedPost, record: PostRenderRecord, factText: ReviewLoopOptions['factText'], suffix = ''): ReviewInput {
  const rendered = post.art?.candidates.find((c) => c.optionId === record.optionId);
  const fact = (post.factIds ?? []).map(factText).find((t) => t) ?? post.headline;
  return {
    key: post.id,
    imagePath: join(ctx.outDir, `${post.id}${suffix}.jpg`),
    headline: plain(post.headline),
    ...(post.subline && !suffix ? { subline: plain(post.subline) } : {}),
    fact,
    hasPicture: (rendered?.brief.picture.role ?? 'none') !== 'none',
  };
}

export async function reviewAndRepair(options: ReviewLoopOptions): Promise<ReviewLoopReport> {
  const log = options.log ?? console.log;
  const { ai, ctx, plan } = options;
  const budget = new ReviewBudget(ai, options.budgetUsd);
  const posts = plan.posts.filter((p) => p.art && options.records.some((r) => r.postId === p.id && r.status !== 'render_failed'));
  const recordOf = (id: string): PostRenderRecord => options.records.find((r) => r.postId === id) as PostRenderRecord;
  const report: PostReviewReport[] = [];

  log(`Reviewing ${posts.length} poster${posts.length === 1 ? '' : 's'} (cap $${options.budgetUsd.toFixed(3)} for review and repair)…`);
  const first = await reviewPosters({ ai, budget, posts: posts.map((p) => inputFor(ctx, p, recordOf(p.id), options.factText)), ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}) });

  for (const post of posts) {
    const outcome = first.get(post.id);
    if (!outcome || outcome.status === 'skipped') {
      log(`${post.id}: not reviewed (${outcome?.status === 'skipped' ? `${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ''}` : 'no result'}); left as it was`);
      report.push({ postId: post.id, final: 'unreviewed', reason: outcome?.status === 'skipped' ? outcome.reason : 'no_result' });
      continue;
    }
    const one = outcome.review;
    const entry: PostReviewReport = { postId: post.id, first: { observed: one.observed, scores: one.scores, defects: one.defects, decision: one.decision }, final: 'accepted' };
    report.push(entry);

    if (one.decision.action === 'accept') {
      log(`${post.id}: passed review${one.defects.length ? ` (notes: ${one.defects.map((d) => d.code).join(', ')})` : ''}`);
      continue;
    }
    if (one.decision.action === 'discard') {
      await reject(options, post.id, entry, one.decision.reason);
      continue;
    }

    entry.repairs = one.decision.repairs;
    const rendered = recordOf(post.id).optionId;
    const cached = new Map<string, boolean>();
    for (const c of post.art?.candidates ?? []) if (c.imagePrompt) cached.set(c.optionId, await exists(scenePathFor(ctx.outDir, post.id, c.imagePrompt)));
    const plan2 = planRepair(post.art as PostArt, rendered, one.decision.repairs, (c) => cached.get(c.optionId) === true);
    if ('impossible' in plan2) {
      entry.repairFailure = plan2.impossible;
      await reject(options, post.id, entry, `repair not possible: ${plan2.impossible}`);
      continue;
    }
    // The second review is budgeted before the repair starts: a repaired poster that cannot be re-reviewed is not accepted.
    if (!budget.canAfford(REVIEW_COST_ESTIMATE_USD)) {
      await reject(options, post.id, entry, 'review_incomplete_budget: the repaired poster could not be reviewed within the budget');
      continue;
    }
    log(`${post.id}: repairing (${one.decision.repairs.join(', ')})…`);
    const again = await renderArtPost(ctx, post, { ...plan2.override, outName: `${post.id}.repair` });
    if (again.status === 'render_failed') {
      entry.repairFailure = again.failure ?? 'render failed';
      await reject(options, post.id, entry, `the repaired poster did not render: ${entry.repairFailure}`);
      continue;
    }
    const second = await reviewPosters({
      ai,
      budget,
      posts: [{ ...inputFor(ctx, { ...post, ...(plan2.override.withoutSubline ? { subline: '' } : {}) }, again, options.factText, '.repair'), hasPicture: (post.art?.candidates.find((c) => c.optionId === again.optionId)?.brief.picture.role ?? 'none') !== 'none' }],
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    });
    const outcome2 = second.get(post.id);
    if (!outcome2 || outcome2.status === 'skipped') {
      await reject(options, post.id, entry, `review_incomplete_budget: the repaired poster could not be reviewed (${outcome2?.status === 'skipped' ? outcome2.reason : 'no result'})`);
      continue;
    }
    entry.second = { observed: outcome2.review.observed, scores: outcome2.review.scores, defects: outcome2.review.defects, decision: decideAfterRepair(outcome2.review) };
    if (entry.second.decision.action === 'accept') {
      await adopt(options, post, again, plan2.override.withoutSubline === true);
      entry.final = 'accepted_after_repair';
      log(`${post.id}: accepted after repair (${one.decision.repairs.join(', ')})`);
    } else {
      await reject(options, post.id, entry, entry.second.decision.action === 'discard' ? entry.second.decision.reason : 'rejected');
    }
  }

  const result: ReviewLoopReport = { at: new Date().toISOString(), budgetUsd: options.budgetUsd, spentUsd: budget.spentUsd(), posts: report };
  await writeFileAtomic(join(ctx.brandDir, `review-report-${options.planFile}`), `${JSON.stringify(result, null, 2)}\n`);
  log(`Review: ${report.filter((r) => r.final === 'accepted').length} passed, ${report.filter((r) => r.final === 'accepted_after_repair').length} repaired, ${report.filter((r) => r.final === 'rejected').length} rejected, ${report.filter((r) => r.final === 'unreviewed').length} not reviewed; spent $${budget.spentUsd().toFixed(4)} of $${options.budgetUsd.toFixed(3)}.`);
  return result;
}

/** Records the rejection like a person would, keeps the poster file out of the way, and removes any repaired draft. */
async function reject(options: ReviewLoopOptions, postId: string, entry: PostReviewReport, reason: string): Promise<void> {
  const { ctx } = options;
  entry.final = 'rejected';
  entry.reason = reason;
  options.log?.(`${postId}: rejected by review (${reason})`);
  await setApproval({ brandDir: ctx.brandDir, planFile: options.planFile, postId, decision: 'reject', reason: `auto-review: ${reason}`.slice(0, 300), by: 'auto-review', outDir: ctx.outDir });
  if (await exists(join(ctx.outDir, `${postId}.jpg`))) await rename(join(ctx.outDir, `${postId}.jpg`), join(ctx.outDir, `${postId}.rejected.jpg`));
  await rm(join(ctx.outDir, `${postId}.repair.jpg`), { force: true });
}

/** Makes the repaired poster the poster: the original is kept beside it, and the render report and plan describe what is now drawn. */
async function adopt(options: ReviewLoopOptions, post: PlannedPost, again: PostRenderRecord, subline: boolean): Promise<void> {
  const { ctx } = options;
  await copyFile(join(ctx.outDir, `${post.id}.jpg`), join(ctx.outDir, `${post.id}.original.jpg`));
  await rename(join(ctx.outDir, `${post.id}.repair.jpg`), join(ctx.outDir, `${post.id}.jpg`));
  const reportPath = join(ctx.outDir, 'render-report.json');
  const records = JSON.parse(await readFile(reportPath, 'utf8')) as PostRenderRecord[];
  await writeFileAtomic(reportPath, `${JSON.stringify(records.map((r) => (r.postId === post.id ? { ...again, postId: post.id } : r)), null, 2)}\n`);
  if (subline) {
    const planPath = join(ctx.brandDir, options.planFile);
    const raw = JSON.parse(await readFile(planPath, 'utf8')) as { posts: Array<Record<string, unknown>> };
    const target = raw.posts.find((p) => p['id'] === post.id);
    if (target) target['subline'] = '';
    await writeFileAtomic(planPath, `${JSON.stringify(raw, null, 2)}\n`);
  }
}
