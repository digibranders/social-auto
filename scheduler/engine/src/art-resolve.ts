/**
 * The last step of art direction before any picture is paid for: every post ends with a structurally valid brief (and its
 * image prompt, or none) or an explicit failure with coded reasons. Nothing here calls a model or an image provider and
 * nothing is written to history; the provisional records come back for the caller to commit. A fallback keeps facts first,
 * then creative quality, then completion: it repairs what is harmless, tries other eligible options before shrinking
 * type, removes a picture that the policy blocked rather than rebuilding it, and never truncates approved copy.
 *
 * "direction_ready" certifies structure only. Text fit is advisory here, so a post whose fit is uncertain is
 * "ready_pending_measurement": the renderer (2.2) must measure it in a real browser and may reflow, change family or fail.
 * Neither status says the poster looks good; that is for rendering and the visual review.
 */
import { parseArtBrief, type ArtBrief, type HeadlineScale, type PictureMedium } from './art-brief.ts';
import { buildImagePrompt } from './art-prompt.ts';
import type { DirectedPost, DirectionOutcome, DirectionReason, DirectionReasonCode } from './art-director.ts';
import { optionId } from './art-director.ts';
import { chooseBrandSlots, type ArtRecord, type ScoredOption } from './art-options.ts';
import type { Brand } from './content.ts';
import { SAFE_FAMILY, checkBriefAgainstFamily, familyById, layoutRegistry, type LayoutFamily } from './layout-registry.ts';
import { checkPicturePolicy, defaultPicturePolicy, type PolicyCategory } from './picture-policy.ts';

export type ReasonCode =
  | DirectionReasonCode
  | 'fit_overflow_estimated'
  | 'fit_unverified'
  | 'fallback_option'
  | 'picture_removed'
  | 'picture_written_by_code'
  | 'no_valid_family'
  | 'missing_headline'
  | 'final_brief_invalid'
  | 'prompt_failed';

export type Severity = 'info' | 'warning' | 'hard';

export interface Reason {
  code: ReasonCode;
  severity: Severity;
  message: string;
}

/** How serious each code is. A hard reason on a post means the post is rejected, never rendered with an invalid brief. */
export const SEVERITY: Readonly<Record<ReasonCode, Severity>> = {
  invalid_option_id: 'warning',
  missing_direction: 'warning',
  duplicate_direction: 'warning',
  unsupported_medium: 'warning',
  missing_picture: 'warning',
  invalid_scale: 'warning',
  invalid_alignment: 'warning',
  picture_policy_blocked: 'warning',
  no_concept: 'info',
  no_options: 'warning',
  batch_too_large: 'warning',
  model_failed: 'warning',
  brief_invalid: 'warning',
  no_slot_placement: 'warning',
  fit_overflow_estimated: 'warning',
  fit_unverified: 'warning',
  fallback_option: 'info',
  picture_removed: 'warning',
  picture_written_by_code: 'info',
  no_valid_family: 'hard',
  missing_headline: 'hard',
  final_brief_invalid: 'hard',
  prompt_failed: 'hard',
};

const reasonOf = (code: ReasonCode, message: string): Reason => ({ code, severity: SEVERITY[code], message });

export type Resolution = 'directed' | 'repaired' | 'fallback';
export type PostStatus = 'direction_ready' | 'ready_pending_measurement';
export type PlanStatus = 'complete' | 'pending_render_validation' | 'partial' | 'incomplete_required_count' | 'failed';

export interface ReadyPost {
  postId: string;
  resolution: Resolution;
  status: PostStatus;
  /** What the model asked for, when it named an option of the post. */
  requestedOptionId?: string;
  actualOptionId: string;
  brief: ArtBrief;
  /** Absent when the brief wants no picture, so no image is requested. */
  imagePrompt?: string;
  /** The ACTUAL choice, to commit once the poster is accepted. */
  record: ArtRecord;
  reasons: Reason[];
  warnings: string[];
}

export interface FailedPost {
  postId: string;
  reasons: Reason[];
}

export interface BatchQuality {
  repaired: number;
  fallback: number;
  /** Posts that ended on the safe family although the shortlist led elsewhere: a forced fallback, not a design choice. */
  safeFamilyFallbacks: number;
  policyBlocks: number;
  failed: number;
  familyDistribution: Record<string, number>;
  flagged: boolean;
  flags: string[];
}

export interface FinalizedDirections {
  ready: ReadyPost[];
  failed: FailedPost[];
  status: PlanStatus;
  quality: BatchQuality;
}

export interface FinalizeSettings {
  requestedPosts?: number;
  minimumAcceptablePosts?: number;
  requireExactCount?: boolean;
  allowPartialApproval?: boolean;
  /** A batch is flagged for review when this many posts needed a fallback. */
  flagFallbacksAt?: number;
  flagOnPolicyBlock?: boolean;
  policy?: readonly PolicyCategory[];
  /** Picture treatments written by code when a picture direction is missing or malformed, per medium; rotated, never one fixed line. */
  compositions?: Partial<Record<PictureMedium, readonly string[]>>;
  scenes?: readonly string[];
  moods?: readonly string[];
}

export const defaultCompositions: Readonly<Record<PictureMedium, readonly string[]>> = {
  illustration: ['close-up with the subject filling the frame', 'wide view with the subject small and centred', 'three-quarter view from slightly above'],
  'still-life': ['single object, close and low angle', 'object slightly off-centre with generous space', 'object seen from directly above'],
  isometric: ['isometric view from the front left', 'isometric view from the front right', 'isometric view from above'],
  'photo-like': ['close-up with shallow depth of field', 'medium shot at eye level', 'wide shot with generous space around the subject'],
  abstract: ['layered shapes flowing from left to right', 'concentric shapes around the centre', 'scattered shapes with one dominant form'],
  diagram: ['balanced arrangement of simple nodes', 'linear left-to-right flow of simple shapes', 'radial arrangement around one central shape'],
};
const defaultScenes = ['a softly lit, uncluttered setting', 'a clean studio-like setting', 'an open, airy setting'];
const defaultMoods = ['calm', 'focused', 'confident', 'warm'];

/** Directions the model got wrong in ways code can mend without changing the layout it chose. */
const REPAIRABLE: ReadonlySet<DirectionReasonCode> = new Set(['invalid_scale', 'invalid_alignment', 'unsupported_medium', 'missing_picture']);

const plain = (text: string): string => text.replaceAll('|', '').trim();

function defaultScale(option: ScoredOption, family: LayoutFamily): HeadlineScale {
  const scales = family.scales;
  if (option.fit === 'likely_fit') return scales[0] as HeadlineScale;
  if (option.fit === 'uncertain_fit') return (scales[1] ?? scales[scales.length - 1]) as HeadlineScale;
  return scales[scales.length - 1] as HeadlineScale;
}

function uniqueOptions(post: DirectedPost): ScoredOption[] {
  const seen = new Set<string>();
  return [...post.shortlist, ...(post.eligible ?? [])].filter((o) => {
    const id = optionId(o);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Picks the next treatment from a list, never repeating the previous poster's. */
function rotate(list: readonly string[], seed: number, previous?: string): string {
  for (let i = 0; i < list.length; i++) {
    const candidate = list[(seed + i) % list.length] as string;
    if (candidate !== previous) return candidate;
  }
  return list[seed % list.length] as string;
}

interface Built {
  brief: ArtBrief;
  imagePrompt?: string;
  record: ArtRecord;
  warnings: string[];
}

/** Builds and fully validates a brief for an option. Returns the problem when it cannot be made valid. */
function buildFor(
  post: DirectedPost,
  option: ScoredOption,
  running: readonly ArtRecord[],
  brand: Pick<Brand, 'colors'>,
  settings: FinalizeSettings,
  picture: { kind: 'keep'; brief: ArtBrief } | { kind: 'code' },
  scaleAndAlignment?: { headlineScale: HeadlineScale; alignment: 'start' | 'center' },
): Built | Reason {
  const family = familyById(layoutRegistry, option.layout);
  if (!family) return reasonOf('final_brief_invalid', `unknown layout "${option.layout}"`);
  const slots = chooseBrandSlots(family, option.zone, running);
  if (!slots) return reasonOf('final_brief_invalid', `no collision-free brand placement in ${family.id}/${option.zone}`);
  const concept = post.concept;
  const warnings: string[] = [];

  let pictureRaw: Record<string, unknown>;
  if (option.pictureRole === 'none') {
    pictureRaw = { role: 'none' };
  } else {
    if (!concept?.visualSubject?.trim() || !concept.visualAction?.trim()) return reasonOf('final_brief_invalid', 'a picture option needs the accepted concept subject and action');
    const medium = option.mediums[0];
    if (!medium) return reasonOf('final_brief_invalid', `option ${optionId(option)} offers no picture medium`);
    const previous = running[running.length - 1]?.pictureComposition;
    const seed = running.filter((r) => r.pictureComposition).length;
    const compositions = settings.compositions?.[medium] ?? defaultCompositions[medium];
    const policy = settings.policy ?? defaultPicturePolicy;
    const fromConcept = concept.visualComposition?.trim() ?? '';
    const conceptSafe = fromConcept.length > 0 && checkPicturePolicy([fromConcept], { productAsset: post.productAsset === true, credential: post.credential === true }, policy).violations.length === 0;
    pictureRaw = {
      role: option.pictureRole,
      medium,
      subject: concept.visualSubject,
      action: concept.visualAction,
      scene: conceptSafe ? fromConcept : rotate(settings.scenes ?? defaultScenes, seed, undefined),
      composition: rotate(compositions, seed, previous),
      mood: rotate(settings.moods ?? defaultMoods, seed),
      paletteUse: 'balanced',
    };
    if (picture.kind === 'keep' && picture.brief.picture.role !== 'none') pictureRaw = { ...picture.brief.picture };
  }

  const alignment = scaleAndAlignment?.alignment ?? (option.zone === 'center' ? 'center' : 'start');
  const headlineScale = scaleAndAlignment?.headlineScale ?? defaultScale(option, family);
  let brief: ArtBrief;
  try {
    brief = parseArtBrief({ layout: option.layout, hierarchy: option.hierarchy, textZone: option.zone, headlineScale, alignment, picture: pictureRaw, ...slots }, post.id);
  } catch (error) {
    return reasonOf('final_brief_invalid', error instanceof Error ? error.message : String(error));
  }
  const check = checkBriefAgainstFamily(brief, layoutRegistry);
  if (!check.ok) return reasonOf('final_brief_invalid', check.problems.map((p) => p.message).join('; '));

  let imagePrompt: string | undefined;
  if (brief.picture.role !== 'none') {
    const zone = family.zones[option.zone];
    try {
      imagePrompt = buildImagePrompt({ brief, brand, textSlots: zone?.textSlots ?? [] });
    } catch (error) {
      return reasonOf('prompt_failed', error instanceof Error ? error.message : String(error));
    }
    if (!imagePrompt) return reasonOf('prompt_failed', 'the image prompt builder produced no prompt for a picture brief');
  }
  const medium = brief.picture.role === 'none' ? undefined : brief.picture.medium;
  const composition = brief.picture.role === 'none' ? undefined : brief.picture.composition;
  const record: ArtRecord = {
    layout: option.layout,
    hierarchy: option.hierarchy,
    textZone: option.zone,
    pictureRole: option.pictureRole,
    ...(medium ? { pictureMedium: medium } : {}),
    ...(composition ? { pictureComposition: composition } : {}),
    logoSlot: slots.logoSlot,
    ctaSlot: slots.ctaSlot,
  };
  return { brief, ...(imagePrompt ? { imagePrompt } : {}), record, warnings };
}

const isReason = <T extends object>(value: T | Reason): value is Reason => 'code' in value;
const asReason = (r: DirectionReason): Reason => reasonOf(r.code, r.message);

interface Attempt {
  built: Built;
  option: ScoredOption;
  resolution: Resolution;
  reasons: Reason[];
}

/** Resolves every post of a batch. Pure: same inputs give the same result and nothing is mutated or committed. */
export function finalizeDirections(input: {
  posts: readonly DirectedPost[];
  outcome: DirectionOutcome;
  history: readonly ArtRecord[];
  brand: Pick<Brand, 'colors'>;
  settings?: FinalizeSettings;
}): FinalizedDirections {
  const settings = input.settings ?? {};
  const running: ArtRecord[] = [...input.history];
  const ready: ReadyPost[] = [];
  const failed: FailedPost[] = [];

  for (const post of input.posts) {
    if (!plain(post.facts.headline)) {
      failed.push({ postId: post.id, reasons: [reasonOf('missing_headline', 'the post has no headline')] });
      continue;
    }
    const directed = input.outcome.resolved.find((r) => r.postId === post.id);
    const unresolved = input.outcome.unresolved.find((u) => u.postId === post.id);
    const options = uniqueOptions(post);
    const byId = new Map(options.map((o) => [optionId(o), o]));
    const carried = (unresolved?.reasons ?? []).map(asReason);
    const requestedOptionId = directed?.optionId ?? unresolved?.requestedOptionId;
    const noVisual = !post.concept?.visualSubject?.trim() || !post.concept?.visualAction?.trim();
    const blocked = carried.some((r) => r.code === 'picture_policy_blocked');
    const attempts: Array<() => Attempt | Reason> = [];
    const failures: Reason[] = [];

    const tryOption = (option: ScoredOption, resolution: Resolution, reasons: Reason[], picture: { kind: 'keep'; brief: ArtBrief } | { kind: 'code' }, sa?: { headlineScale: HeadlineScale; alignment: 'start' | 'center' }) => (): Attempt | Reason => {
      const built = buildFor(post, option, running, input.brand, settings, picture, sa);
      return isReason(built) ? built : { built, option, resolution, reasons };
    };

    const directedOption = directed ? byId.get(directed.optionId) : undefined;
    const lastResort = options.filter((o) => o.layout === SAFE_FAMILY);
    const notOverflow = (o: ScoredOption): boolean => o.fit !== 'likely_overflow';

    if (directed && directedOption) {
      const overflow = directedOption.fit === 'likely_overflow';
      const alternative = overflow ? options.find((o) => notOverflow(o) && (o.pictureRole === 'none') === (directedOption.pictureRole === 'none')) ?? options.find(notOverflow) : undefined;
      if (alternative && alternative !== directedOption) {
        attempts.push(tryOption(alternative, 'repaired', [reasonOf('fit_overflow_estimated', `${optionId(directedOption)} is estimated to overflow; ${optionId(alternative)} was used`)], { kind: 'code' }));
      }
      attempts.push(tryOption(directedOption, 'directed', overflow ? [reasonOf('fit_unverified', 'no option is estimated to fit; the renderer must measure and may fail the post')] : [], { kind: 'keep', brief: directed.brief }, { headlineScale: directed.brief.headlineScale, alignment: directed.brief.alignment }));
    }

    {
      const requested = requestedOptionId ? byId.get(requestedOptionId) : undefined;
      const wantsNoPicture = noVisual || blocked;
      const baseReasons = carried.length > 0 ? carried : [directed ? reasonOf('brief_invalid', 'the directed brief failed final validation') : reasonOf('missing_direction', 'the post was not directed')];
      const removed = blocked ? [reasonOf('picture_removed', 'the picture the model asked for was held back by the picture policy, so the poster uses no picture')] : [];
      const noPicture = options.filter((o) => o.pictureRole === 'none');
      const ordered = (list: readonly ScoredOption[]): ScoredOption[] => [...list.filter(notOverflow), ...list.filter((o) => !notOverflow(o))];

      if (requested && !wantsNoPicture && carried.every((r) => REPAIRABLE.has(r.code as DirectionReasonCode))) {
        attempts.push(tryOption(requested, 'repaired', [...baseReasons, ...(requested.pictureRole === 'none' ? [] : [reasonOf('picture_written_by_code', 'the picture treatment was written by code from the accepted concept')])], { kind: 'code' }));
      }
      if (wantsNoPicture) {
        const sameFamily = requested ? noPicture.filter((o) => o.layout === requested.layout) : [];
        const lead = post.shortlist[0];
        const nearLead = lead ? noPicture.filter((o) => o.layout === lead.layout) : [];
        for (const option of ordered([...new Set([...sameFamily, ...nearLead, ...noPicture])])) attempts.push(tryOption(option, 'fallback', [...baseReasons, ...removed, reasonOf('fallback_option', `${optionId(option)} was used`)], { kind: 'code' }));
      } else {
        for (const option of ordered(options)) attempts.push(tryOption(option, 'fallback', [...baseReasons, reasonOf('fallback_option', `${optionId(option)} was used`), ...(option.pictureRole === 'none' ? [] : [reasonOf('picture_written_by_code', 'the picture treatment was written by code from the accepted concept')])], { kind: 'code' }));
      }
      for (const option of ordered(lastResort)) attempts.push(tryOption(option, 'fallback', [...baseReasons, reasonOf('fallback_option', `${optionId(option)} was used`)], { kind: 'code' }));
    }

    let chosen: Attempt | undefined;
    for (const attempt of attempts) {
      const result = attempt();
      if (isReason(result)) failures.push(result);
      else {
        chosen = result;
        break;
      }
    }
    if (!chosen) {
      failed.push({ postId: post.id, reasons: [...carried, ...(options.length === 0 ? [reasonOf('no_valid_family', 'no eligible layout exists for this post')] : failures.slice(-1))] });
      continue;
    }

    const { built, option, resolution, reasons } = chosen;
    const status: PostStatus = option.fit === 'likely_fit' ? 'direction_ready' : 'ready_pending_measurement';
    if (status === 'ready_pending_measurement' && !reasons.some((r) => r.code === 'fit_unverified' || r.code === 'fit_overflow_estimated')) {
      reasons.push(reasonOf('fit_unverified', `text fit is ${option.fit.replace('_', ' ')}; the renderer must measure it`));
    }
    running.push(built.record);
    ready.push({
      postId: post.id,
      resolution,
      status,
      ...(requestedOptionId ? { requestedOptionId } : {}),
      actualOptionId: optionId(option),
      brief: built.brief,
      ...(built.imagePrompt ? { imagePrompt: built.imagePrompt } : {}),
      record: built.record,
      reasons,
      warnings: [...(directed?.warnings ?? []), ...built.warnings],
    });
  }

  return { ready, failed, ...summarise(input.posts, ready, failed, input.outcome, settings) };
}

function summarise(posts: readonly DirectedPost[], ready: readonly ReadyPost[], failed: readonly FailedPost[], outcome: DirectionOutcome, settings: FinalizeSettings): { status: PlanStatus; quality: BatchQuality } {
  const requested = settings.requestedPosts ?? posts.length;
  const minimum = settings.minimumAcceptablePosts ?? 1;
  const familyDistribution: Record<string, number> = {};
  for (const r of ready) familyDistribution[r.brief.layout] = (familyDistribution[r.brief.layout] ?? 0) + 1;
  const leadOf = new Map(posts.map((p) => [p.id, p.shortlist[0]?.layout]));
  const fallback = ready.filter((r) => r.resolution === 'fallback').length;
  const safeFamilyFallbacks = ready.filter((r) => r.resolution === 'fallback' && r.brief.layout === SAFE_FAMILY && leadOf.get(r.postId) !== SAFE_FAMILY).length;
  const blockedIds = new Set([
    ...ready.filter((r) => r.reasons.some((x) => x.code === 'picture_policy_blocked')).map((r) => r.postId),
    ...failed.filter((f) => f.reasons.some((x) => x.code === 'picture_policy_blocked')).map((f) => f.postId),
    ...outcome.unresolved.filter((u) => u.reasons.some((x) => x.code === 'picture_policy_blocked')).map((u) => u.postId),
  ]);
  const flags: string[] = [];
  if (fallback >= (settings.flagFallbacksAt ?? 2)) flags.push(`${fallback} of ${posts.length} posts needed a fallback`);
  if (settings.flagOnPolicyBlock !== false && blockedIds.size > 0) flags.push(`${blockedIds.size} post(s) had a picture held back by the picture policy`);
  if (failed.length > 0) flags.push(`${failed.length} post(s) could not be directed`);
  if (posts.length >= 3 && ready.every((r) => r.resolution === 'fallback')) flags.push('every post fell back: the art director may be failing systematically');

  let status: PlanStatus;
  if (ready.length === 0) status = 'failed';
  else if (ready.length < requested && (settings.requireExactCount === true || settings.allowPartialApproval === false || ready.length < minimum)) status = 'incomplete_required_count';
  else if (ready.length < requested) status = 'partial';
  else status = ready.some((r) => r.status === 'ready_pending_measurement') ? 'pending_render_validation' : 'complete';

  return {
    status,
    quality: {
      repaired: ready.filter((r) => r.resolution === 'repaired').length,
      fallback,
      safeFamilyFallbacks,
      policyBlocks: blockedIds.size,
      failed: failed.length,
      familyDistribution,
      flagged: flags.length > 0,
      flags,
    },
  };
}

export interface RenderCandidate {
  optionId: string;
  brief: ArtBrief;
  /** Absent when the brief wants no picture. */
  imagePrompt?: string;
  /** The art record to commit if this candidate is the one that renders. */
  record: ArtRecord;
}

/**
 * The candidates the renderer may try for a post, best first: the resolved brief, then other eligible options (those not
 * estimated to overflow first, other families before the same family) and finally the safe family. Each carries its own
 * brief, image prompt and record, so a change of family during rendering updates the art record and the picture's text zone.
 */
export function renderCandidates(input: {
  post: DirectedPost;
  ready: ReadyPost;
  history: readonly ArtRecord[];
  brand: Pick<Brand, 'colors'>;
  settings?: FinalizeSettings;
  limit?: number;
}): RenderCandidate[] {
  const { post, ready } = input;
  const settings = input.settings ?? {};
  const first: RenderCandidate = { optionId: ready.actualOptionId, brief: ready.brief, ...(ready.imagePrompt ? { imagePrompt: ready.imagePrompt } : {}), record: ready.record };
  const others = uniqueOptions(post).filter((o) => optionId(o) !== ready.actualOptionId);
  const sameFamily = (o: ScoredOption): number => (o.layout === ready.brief.layout ? 1 : 0);
  const fits = (o: ScoredOption): number => (o.fit === 'likely_overflow' ? 1 : 0);
  const ordered = [...others].sort((a, b) => fits(a) - fits(b) || sameFamily(a) - sameFamily(b));
  const safe = ordered.filter((o) => o.layout === SAFE_FAMILY && o.pictureRole === 'none');
  const picks = [...ordered.filter((o) => o.layout !== SAFE_FAMILY), ...safe];
  const out: RenderCandidate[] = [first];
  const running = input.history.filter((r) => r !== ready.record);
  for (const option of picks) {
    if (out.length >= (input.limit ?? 4)) break;
    const built = buildFor(post, option, running, input.brand, settings, { kind: 'code' });
    if (isReason(built)) continue;
    out.push({ optionId: optionId(option), brief: built.brief, ...(built.imagePrompt ? { imagePrompt: built.imagePrompt } : {}), record: built.record });
  }
  if (!out.some((c) => c.brief.layout === SAFE_FAMILY)) {
    const lastResort = uniqueOptions(post).find((o) => o.layout === SAFE_FAMILY && o.pictureRole === 'none');
    const built = lastResort ? buildFor(post, lastResort, running, input.brand, settings, { kind: 'code' }) : undefined;
    if (lastResort && built && !isReason(built)) out.push({ optionId: optionId(lastResort), brief: built.brief, record: built.record });
  }
  return out;
}
