/**
 * Makes the fully AI poster of each post of a plan, within the spending rules, and records exactly what happened. One post at a time:
 *   attempt 1: the picture model draws the whole poster from the prompt contract, one vision request reads it, and code judges it (ai-creative.ts);
 *   attempt 2: only when attempt 1 was rejected for something a new instruction can fix, with the defects written into the prompt.
 * A poster that is rejected twice, or whose budget is spent, is dropped: fewer posters, never a poster that did not pass. An accepted poster is only
 * "pending": nothing here approves, schedules or publishes anything.
 */
import { SQUARE_SHAPE, type Network, type PictureShape } from './networks.ts';
import { headlineStylesEnabled, leanFor, loadTypeHistory, saveTypeHistory, type LeanRecord } from './type-direction.ts';
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { generateScene } from './ai.ts';
import { decideReadings, thirdReading, type Dispute } from './creative-adjudication.ts';
import { buildCreativePrompt, isRecoverable, plainHeadline, retryNoteFor, reviewCreative, type CreativeDefect, type CreativeReview, type TextManifest } from './ai-creative.ts';
import type { Brand, PlannedPost } from './content.ts';
import type { LogoPlacementRecord } from './branding.ts';
import { inspectLogoFile } from './branding.ts';
import { placeLogo as placeLogoOnPoster, type Box as PixelBox, type Placement, type PlacementFailure, type PlacementInput } from './logo-compositor.ts';
import { BudgetError } from './paid-ledger.ts';
import { headlineGateFromEnv, judgeHeadlines, scoreHeadlines, type HeadlineGateConfig, type HeadlineScore } from './headline-gate.ts';
import { batchLookAlikes, compareIdeas, directBatch, loadConceptHistory, openAiEmbedder, saveConceptHistory, type DirectorResult, type LookAlikes, type PlannedConcept } from './creative-director.ts';

export interface CreativeAttempt {
  n: number;
  prompt: string;
  imageFile: string;
  /** Every independent reading of the poster; it must pass all of them. */
  readings: CreativeReview[];
  accepted: boolean;
  defects: CreativeDefect[];
  /** What one reader doubted that was not a rejection, or that a third reading cleared. */
  warnings?: string[];
  /** The one targeted third reading, when the first two disagreed about a hard gate. */
  adjudication?: { gates: string[]; cropped: boolean; confirmed: string[]; cleared: string[]; boxes: number[][] };
  /** The failure that ended this attempt before it could be judged, when there was one. */
  error?: string;
}

export interface CreativeResult {
  postId: string;
  manifest: TextManifest;
  status: 'accepted' | 'rejected' | 'budget_stopped' | 'failed' | 'dropped';
  /** How the editorial check judged the headline, when the check ran. */
  headline?: HeadlineScore;
  /** The picture the creative director chose for this post. */
  concept?: PlannedConcept;
  /** The weight and character the headline lettering was nudged towards (type-direction.ts), when the picture was drawn for a network. */
  typeLean?: { weight: string; character: string };
  /** What the plan said about people and what the readers saw in the poster that was kept (or the last one drawn). */
  people?: { planned: boolean; observed: 'none' | 'background' | 'prominent'; description: string };
  /** The file of the accepted poster: with the real logo on it when it carries one. */
  file?: string;
  /** Where the real logo was put, when this poster carries it (the picture the model drew is kept beside it as the attempt's file). */
  logo?: LogoPlacementRecord;
  attempts: CreativeAttempt[];
  /** Why the post has no accepted poster. */
  reason?: string;
  costUsd: number;
}

export interface CreativeReport {
  brand: string;
  generatedAt: string;
  results: CreativeResult[];
  /** Set when a spending cap ended the whole run. */
  stoppedBy?: string;
  /** What the creative director decided before any picture was bought: every flagged pair and what was decided, and the posts it dropped. */
  direction?: Pick<DirectorResult, 'flags' | 'dropped'>;
  /** Posters of the finished batch that look alike as pictures, and posters whose headlines are set alike, as found by the side-by-side check. The first rejects the later poster; the second is recorded for the owner and for the next brief. */
  lookAlikes?: LookAlikes;
  /** How many posters may show people prominently, and which of the finished ones did. */
  peopleRule?: { cap: number; prominent: string[] };
}

export interface CreativeDeps {
  /** For tests: replaces the picture call. */
  scene?: (prompt: string, outPath: string, shape: PictureShape) => Promise<void>;
  /** For tests: replaces the vision call. */
  review?: (imagePath: string, message: string, reading: number) => Promise<CreativeReview>;
  /** How many independent readings a poster gets first (two); a third is made only to settle a disagreement. */
  readings?: number;
  /** For tests: replaces the editorial check of the headlines (one score per post). */
  headlines?: (items: ReadonlyArray<{ id: string; headline: string; fact: string }>) => Promise<HeadlineScore[]>;
  /** For tests: the editorial gate's settings; otherwise they come from the environment. */
  headlineGate?: { enabled: boolean; config: HeadlineGateConfig };
  /** For tests: replaces the third reading. */
  third?: (dispute: Dispute, imageFile: string) => Promise<{ reading: CreativeReview; cropped: boolean }>;
  /** For tests: replaces the creative director (concepts for the batch). */
  direct?: (posts: ReadonlyArray<{ id: string; headline: string; fact: string }>, history: readonly string[]) => Promise<DirectorResult>;
  /** For tests: replaces the side-by-side check of the finished posters. */
  lookAlikes?: (posters: ReadonlyArray<{ id: string; file: string }>) => Promise<LookAlikes>;
  /** For tests: replaces the logo compositor. */
  place?: (input: PlacementInput) => Promise<Placement | PlacementFailure>;
  /** The most picture attempts per poster, the first included. */
  maxAttempts?: number;
  now?: () => Date;
}

export interface CreativeRunInput {
  ai: AiConfig;
  brand: Brand;
  /** Used in file names. */
  brandSlug: string;
  posts: readonly PlannedPost[];
  /** The verified fact each post is about, by post id. */
  factOf: (post: PlannedPost) => string;
  outDir: string;
  /** The brand's folder, where its concept memory is kept; without it there is no memory across weeks. */
  brandDir?: string;
  /** The most posters of a batch that may show people prominently. */
  peopleCap?: number;
  /**
   * Whether the creative director plans the batch (concepts, similarity checks, a replan, a side-by-side check and the concept memory). Off unless set:
   * with it off every poster is drawn on its own from the prompt contract, and no director call, embedding, comparison or side-by-side check is made.
   */
  directorEnabled?: boolean;
  /** The shape every poster of this run is drawn in; square when not given. A run is of one shape: a post that needs two shapes is drawn by two runs. */
  shape?: PictureShape;
  /** An instruction for the first try, for a picture drawn again because it looked like another network's (it is told what to avoid). */
  startNote?: string;
  /** The network every poster of this run is drawn for, when each network gets its own picture: it gets a composition of its own and its own ledger id. */
  network?: Network;
  /** The brand's real logo, when the posters are to carry it: the file (checked and frozen), its shape and the hash it must still have. */
  logo?: { path: string; kind: 'wordmark' | 'symbol'; sha256: string };
  log?: (message: string) => void;
  deps?: CreativeDeps;
}

/** What the website says about the brand's character, as one input to the director: its tone, its audience, what it offers, the typeface its own site uses and its colours. The director decides what to do with it. */
export function brandCharacter(brand: Brand): string {
  return [
    brand.tone ? `Tone: ${brand.tone}.` : '',
    brand.audience ? `Audience: ${brand.audience}.` : '',
    brand.identity?.line ? `What it is: ${brand.identity.line}` : brand.offer ? `What it offers: ${brand.offer}.` : '',
    brand.font ? `Its own site sets text in ${brand.font}.` : '',
    brand.colors ? `Colours on its site: accent ${brand.colors.accent}, ink ${brand.colors.ink}, background ${brand.colors.background}.` : '',
    brand.visualStyle ? `Look: ${brand.visualStyle}` : '',
  ].filter(Boolean).join(' ');
}

/** What the readers saw of people, whichever of them saw the most: nothing, small figures, or people as a main part of the picture. */
export function observedPeople(readings: readonly CreativeReview[]): { observed: 'none' | 'background' | 'prominent'; description: string } {
  const prominent = readings.find((r) => r.people.present && r.people.prominent);
  if (prominent) return { observed: 'prominent', description: prominent.people.description };
  const any = readings.find((r) => r.people.present);
  return any ? { observed: 'background', description: any.people.description } : { observed: 'none', description: '' };
}

/** A poster carries no brand name and no web address; either is drawn only when one was typed for that post (an empty one leaves the line off). */
export const manifestOf = (post: PlannedPost, brand: Brand, logo?: CreativeRunInput['logo']): TextManifest => ({
  headline: plainHeadline(post.headline), brandName: post.signoff?.brandName ?? '', domain: post.signoff?.domain ?? '',
  // A full logo carries the name, so the name is not drawn beside it; a symbol alone does not, so the name stays.
  ...(logo?.kind === 'wordmark' ? { brandSignoff: 'logo' as const } : {}),
});

/** The text the readers found, as boxes in the poster's pixels, or null when any piece of text could not be placed: the logo is never put where text may be. */
export function textBoxesIn(readings: readonly CreativeReview[], width: number, height: number): PixelBox[] | null {
  const boxes: PixelBox[] = [];
  for (const reading of readings) {
    for (const region of reading.regions) {
      if (!region.box) return null;
      boxes.push([Math.round((region.box[0] / 1000) * width), Math.round((region.box[1] / 1000) * height), Math.round((region.box[2] / 1000) * width), Math.round((region.box[3] / 1000) * height)]);
    }
    for (const box of Object.values(reading.markBoxes ?? {})) if (box) boxes.push([Math.round((box[0] / 1000) * width), Math.round((box[1] / 1000) * height), Math.round((box[2] / 1000) * width), Math.round((box[3] / 1000) * height)]);
  }
  return boxes;
}

/** Which corner of the poster the logo went to. */
export function cornerOf(rect: readonly [number, number, number, number], width: number, height: number): LogoPlacementRecord['corner'] {
  return `${rect[1] + rect[3] / 2 < height / 2 ? 'top' : 'bottom'}-${rect[0] + rect[2] / 2 < width / 2 ? 'left' : 'right'}` as LogoPlacementRecord['corner'];
}

export async function makeCreatives(input: CreativeRunInput): Promise<CreativeReport> {
  const { ai, brand, posts, outDir, deps = {} } = input;
  const log = input.log ?? (() => undefined);
  const maxAttempts = deps.maxAttempts ?? 2;
  await mkdir(outDir, { recursive: true });
  const report: CreativeReport = { brand: input.brandSlug, generatedAt: (deps.now?.() ?? new Date()).toISOString(), results: [] };
  // The headline looks this brand was recently nudged towards (only read when pictures are drawn for a network), and the ones this run adds.
  const pastLeans: LeanRecord[] = input.network && input.brandDir && headlineStylesEnabled(process.env) ? await loadTypeHistory(input.brandDir) : [];
  const newLeans: LeanRecord[] = [];

  const shape = input.shape ?? SQUARE_SHAPE;
  const scene = deps.scene ?? (async (prompt: string, outPath: string, drawShape: PictureShape): Promise<void> => {
    await generateScene(ai, { prompt, outPath, width: drawShape.width, height: drawShape.height, seed: 1 }, { openaiImages: 0 });
  });
  const look = deps.review ?? ((imagePath: string, message: string, reading: number): Promise<CreativeReview> => reviewCreative(ai, imagePath, message, undefined, reading, allowedTexts));
  const readings = deps.readings ?? 2;
  let allowedTexts: string[] = [];
  const spent = (postId: string): number => ai.ledger?.spend(postId).poster ?? 0;

  // The editorial gate: a headline that gives the reader nothing, or does not read as natural copy, is dropped before any picture is paid for.
  const gate = deps.headlineGate ?? headlineGateFromEnv(process.env);
  const dropped = new Map<string, { reason: string; score: HeadlineScore }>();
  const scored = new Map<string, HeadlineScore>();
  if (gate.enabled && posts.length > 0) {
    ai.usage.post = null;
    ai.usage.purpose = 'review';
    try {
      const items = posts.map((post) => ({ id: post.id, headline: plainHeadline(post.headline), fact: input.factOf(post) }));
      const scores = await (deps.headlines ?? ((list) => scoreHeadlines(ai, list)))(items);
      for (const verdict of judgeHeadlines(scores, gate.config)) {
        scored.set(verdict.id, verdict.score);
        if (!verdict.keep) dropped.set(verdict.id, { reason: verdict.reason ?? 'weak headline', score: verdict.score });
      }
    } catch (error) {
      if (error instanceof BudgetError) {
        report.stoppedBy = `${error.code}: ${error.message}`;
        for (const post of posts) report.results.push({ postId: post.id, manifest: manifestOf(post, brand), status: 'budget_stopped', attempts: [], reason: error.message, costUsd: 0 });
  await writeFile(join(outDir, 'creative-report.json'), `${JSON.stringify(report, null, 2)}\n`);
        return report;
      }
      // The check could not be made: the posts go on, as they did before the gate existed, with a note in the log. A gate that fails must not stop the engine.
      log(`the headline check could not be made (${error instanceof Error ? error.message : String(error)}); the headlines were not checked`);
    } finally {
      ai.usage.purpose = 'writing';
    }
  }

  // The creative director (when it is switched on) plans every post of the batch together, and the plan is checked, before any picture is bought.
  const director = input.directorEnabled === true;
  const past = director && input.brandDir ? await loadConceptHistory(input.brandDir) : [];
  const batch = posts.filter((post) => !dropped.has(post.id)).map((post) => ({ id: post.id, headline: plainHeadline(post.headline), fact: input.factOf(post) }));
  let direction: DirectorResult = { concepts: [], dropped: [], flags: [] };
  ai.usage.post = null;
  ai.usage.purpose = 'writing';
  if (director) try {
    direction = deps.direct
      ? await deps.direct(batch, past.map((r) => r.concept))
      : await directBatch(
          { ai, brandName: brand.name, brandLook: brandCharacter(brand), posts: batch, history: past.map((r) => r.concept), typographyHistory: past.flatMap((r) => (r.typography ? [r.typography] : [])), peopleCap: input.peopleCap ?? 1 },
          { embed: openAiEmbedder(ai), sameIdea: (a, b) => compareIdeas(ai, a, b) },
        );
  } catch (error) {
    if (error instanceof BudgetError) {
      report.stoppedBy = `${error.code}: ${error.message}`;
      for (const post of posts) report.results.push({ postId: post.id, manifest: manifestOf(post, brand, input.logo), status: 'budget_stopped', attempts: [], reason: error.message, costUsd: 0 });
      await writeFile(join(outDir, 'creative-report.json'), `${JSON.stringify(report, null, 2)}\n`);
      return report;
    }
    // Without a plan no picture is bought: the model is never left to pick the same default scene four times.
    const reason = `the creative director could not plan the batch: ${error instanceof Error ? error.message : String(error)}`;
    for (const post of posts) report.results.push({ postId: post.id, manifest: manifestOf(post, brand, input.logo), status: 'failed', attempts: [], reason, costUsd: 0 });
    await writeFile(join(outDir, 'creative-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  if (director) report.direction = { flags: direction.flags, dropped: direction.dropped };
  const conceptOf = new Map(direction.concepts.map((c) => [c.postId, c]));

  for (const post of posts) {
    const manifest = manifestOf(post, brand, input.logo);
    const fact = input.factOf(post);
    allowedTexts = [manifest.headline, ...(manifest.subline ? [manifest.subline] : []), ...(manifest.brandSignoff === 'logo' ? [] : [manifest.brandName]), manifest.domain].filter((text) => text !== '');
    const result: CreativeResult = { postId: post.id, manifest, status: 'rejected', attempts: [], costUsd: 0 };
    report.results.push(result);
    if (scored.has(post.id)) result.headline = scored.get(post.id) as HeadlineScore;
    const weak = dropped.get(post.id);
    if (weak) {
      result.status = 'dropped';
      result.reason = weak.reason;
      log(`${post.id}: dropped before any picture was bought (${weak.reason})`);
      continue;
    }
    const concept = conceptOf.get(post.id);
    // With the director off there is no concept, so people are planned by what the batch already has: while it is under its limit of posters showing people prominently
    // they are allowed, and once it is at the limit the next poster is asked to be drawn without them (a retry), instead of being thrown away after it was paid for.
    const prominentSoFar = report.results.filter((r) => r.status === 'accepted' && r.people?.observed === 'prominent').length;
    const plannedPeople = concept?.people ?? prominentSoFar < (input.peopleCap ?? 1);
    if (director && !concept) {
      result.status = 'dropped';
      result.reason = direction.dropped.find((d) => d.postId === post.id)?.reason ?? 'the creative director gave this post no concept';
      log(`${post.id}: dropped (${result.reason})`);
      continue;
    }
    if (concept) result.concept = concept;
    // A picture drawn for a network is its own poster to the ledger (and so is a wide one), so its picture allowance and cap are its own.
    ai.usage.post = `${input.brandSlug}-${post.id}${input.network ? `-${input.network}` : shape.shape === 'square' ? '' : `-${shape.shape}`}`;
    // The ledger counts a poster's calls under the same id.
    const ledgerId = ai.usage.post;
    ai.usage.network = input.network ?? null;
    // A picture drawn for a network is nudged towards a headline look of its own (type-direction.ts), steering clear of the brand's recent ones; a plain post and a switched-off setting keep the model's own choice.
    const typeLean = input.network && headlineStylesEnabled(process.env) ? leanFor(post.id, input.network, [...newLeans, ...pastLeans]) : undefined;
    if (typeLean && input.network) {
      result.typeLean = typeLean;
      newLeans.unshift({ ...typeLean, at: report.generatedAt, postId: `${input.brandSlug}-${post.id}`, network: input.network });
    }
    let note: string | undefined = input.startNote;
    try {
      for (let n = 1; n <= maxAttempts; n++) {
        const imageFile = join(outDir, `${post.id}.attempt${n}.jpg`);
        const prompt = buildCreativePrompt(manifest, { fact, colors: brand.colors, shape, ...(input.network ? { network: input.network } : {}), ...(typeLean ? { typeLean } : {}), ...(concept ? { concept: { concept: concept.concept, factToPicture: concept.factToPicture, typography: concept.typography, ...(concept.photo === undefined ? {} : { photo: concept.photo }) } } : {}), ...(input.logo ? { logo: input.logo.kind } : {}), ...(note ? { retryNote: note } : {}) });
        const attempt: CreativeAttempt = { n, prompt, imageFile, readings: [], accepted: false, defects: [] };
        result.attempts.push(attempt);
        log(`${post.id}: attempt ${n}, drawing the poster…`);
        try {
          await scene(prompt, imageFile, shape);
        } catch (error) {
          if (error instanceof BudgetError) throw error;
          attempt.error = `the picture could not be made: ${error instanceof Error ? error.message : String(error)}`;
          result.status = 'failed';
          result.reason = attempt.error;
          break;
        }
        ai.usage.purpose = 'review';
        try {
          for (let reading = 1; reading <= readings; reading++) attempt.readings.push(await look(imageFile, fact, reading));
        } catch (error) {
          if (error instanceof BudgetError) throw error;
          // A poster that could not be read is not accepted: nothing is assumed about what is on it.
          attempt.error = `the poster could not be read: ${error instanceof Error ? error.message : String(error)}`;
          result.status = 'failed';
          result.reason = attempt.error;
          break;
        } finally {
          ai.usage.purpose = 'writing';
        }
        ai.usage.purpose = 'review';
        let verdict: { accepted: boolean; defects: CreativeDefect[] };
        try {
          const settled = await decideReadings(manifest, attempt.readings, (dispute) => (deps.third ? deps.third(dispute, imageFile) : thirdReading(ai, imageFile, fact, allowedTexts, dispute)), { people: plannedPeople });
          if (settled.third) attempt.readings.push(settled.third.reading);
          attempt.warnings = settled.warnings;
          if (settled.third) attempt.adjudication = { gates: settled.third.gates, cropped: settled.third.cropped, confirmed: settled.third.confirmed, cleared: settled.third.cleared, boxes: settled.third.boxes };
          verdict = settled;
        } catch (error) {
          if (error instanceof BudgetError) throw error;
          // A disagreement that could not be settled is a rejection: nothing is passed on a doubt.
          attempt.warnings = [`the third reading could not be made: ${error instanceof Error ? error.message : String(error)}`];
          verdict = { accepted: false, defects: [{ kind: 'unreadable_text', text: 'a disputed part of the poster could not be settled' }] };
        } finally {
          ai.usage.purpose = 'writing';
        }
        const seen = observedPeople(attempt.readings);
        result.people = { planned: plannedPeople, observed: seen.observed, description: seen.description };
        // People the plan did not mention, small enough not to change the poster: noted for the owner and for the batch, not a rejection.
        if (!plannedPeople && seen.observed === 'background') attempt.warnings = [...(attempt.warnings ?? []), `PEOPLE_PLAN_MISMATCH: the concept has no people, but the poster shows ${seen.description || 'small figures'}`];
        // A poster that passed every check still needs somewhere calm for the real logo: when there is none, it is drawn once more with that asked for.
        const file = join(outDir, `${post.id}.jpg`);
        let logoRecord: LogoPlacementRecord | undefined;
        if (verdict.accepted && input.logo) {
          // The picture is measured as drawn; one that cannot be measured is taken to be the shape that was asked for.
          const size = (() => { try { return inspectLogoFile(imageFile); } catch { return { width: shape.width, height: shape.height }; } })();
          const boxes = textBoxesIn(attempt.readings, size.width, size.height);
          const placed = boxes === null
            ? ({ placed: false, reason: 'NO_SAFE_PLACEMENT', detail: 'a piece of text on the poster could not be located, so no place can be called clear of it' } as PlacementFailure)
            : await (deps.place ?? placeLogoOnPoster)({ posterPath: imageFile, logoPath: input.logo.path, logoKind: input.logo.kind, avoid: boxes, outPath: file, expectedLogoSha256: input.logo.sha256 });
          if (placed.placed) {
            logoRecord = {
              corner: cornerOf(placed.logoRect, placed.width, placed.height), treatment: placed.treatment, ...(placed.haloColor ? { haloColor: placed.haloColor } : {}), ...(placed.plateColor ? { plateColor: placed.plateColor } : {}),
              logoRect: placed.logoRect, contrast: placed.contrast, logoSha256: placed.logoSha256, outputSha256: placed.outputSha256,
            };
          } else if (placed.reason === 'LOGO_CHANGED' || placed.reason === 'LOGO_NOT_DRAWN') {
            // The logo itself is the problem, not the picture: another picture would not help.
            attempt.error = `the real logo could not be put on the poster: ${placed.detail}`;
            result.status = 'failed';
            result.reason = attempt.error;
            break;
          } else {
            verdict = { accepted: false, defects: [{ kind: 'no_logo_space' }] };
            attempt.warnings = [...(attempt.warnings ?? []), `NO_SAFE_LOGO_PLACEMENT: ${placed.detail}`];
          }
        }
        attempt.accepted = verdict.accepted;
        attempt.defects = verdict.defects;
        if (verdict.accepted) {
          if (!logoRecord) await copyFile(imageFile, file);
          result.status = 'accepted';
          result.file = file;
          if (logoRecord) result.logo = logoRecord;
          delete result.reason;
          log(`${post.id}: accepted after ${n} attempt${n === 1 ? '' : 's'}`);
          break;
        }
        note = retryNoteFor(verdict.defects);
        result.status = 'rejected';
        result.reason = `rejected after ${n} attempt${n === 1 ? '' : 's'}: ${note}`;
        log(`${post.id}: attempt ${n} rejected (${note})`);
        if (!isRecoverable(verdict.defects)) break;
      }
    } catch (error) {
      if (!(error instanceof BudgetError)) throw error;
      result.status = 'budget_stopped';
      result.reason = error.message;
      log(`${post.id}: ${error.code}: ${error.message}`);
      // A cap that belongs to the poster ends this poster; any other ends the run.
      if (error.code !== 'POSTER_BUDGET' && error.code !== 'IMAGE_LIMIT') {
        report.stoppedBy = `${error.code}: ${error.message}`;
        result.costUsd = spent(ledgerId);
        break;
      }
    }
    result.costUsd = spent(ledgerId);
  }
  ai.usage.post = null;
  // The finished posters side by side: a poster that repeats an earlier one of the batch is rejected (no second picture is bought for it in this first version).
  const kept = report.results.filter((r) => r.status === 'accepted' && r.file);
  if (director && kept.length >= 2 && !report.stoppedBy) {
    ai.usage.purpose = 'review';
    try {
      const pairs = await (deps.lookAlikes ?? ((posters) => batchLookAlikes(ai, posters)))(kept.map((r) => ({ id: r.postId, file: r.file as string })));
      report.lookAlikes = pairs;
      const order = posts.map((p) => p.id);
      for (const pair of pairs.scenes) {
        const later = order.indexOf(pair.a) > order.indexOf(pair.b) ? pair.a : pair.b;
        const earlier = later === pair.a ? pair.b : pair.a;
        const result = report.results.find((r) => r.postId === later);
        if (result?.status !== 'accepted' || !result.file) continue;
        await rename(result.file, result.file.replace(/\.jpg$/, '.rejected.jpg'));
        delete result.file;
        result.status = 'rejected';
        result.reason = `it looks like ${earlier}: ${pair.why}`;
        log(`${later}: rejected, it looks like ${earlier} (${pair.why})`);
      }
    } catch (error) {
      if (error instanceof BudgetError) report.stoppedBy = `${error.code}: ${error.message}`;
      else log(`the side-by-side check could not be made (${error instanceof Error ? error.message : String(error)}); the posters were each checked on their own`);
    } finally {
      ai.usage.purpose = 'writing';
    }
  }
  // People as drawn, not as planned: when more posters of the batch show people prominently than the batch may, the later ones are rejected (no second picture is bought for them).
  const cap = input.peopleCap ?? 1;
  const prominentOnes = report.results.filter((r) => r.status === 'accepted' && r.file && r.people?.observed === 'prominent');
  report.peopleRule = { cap, prominent: prominentOnes.map((r) => r.postId) };
  for (const result of prominentOnes.slice(cap)) {
    await rename(result.file as string, (result.file as string).replace(/\.jpg$/, '.rejected.jpg'));
    delete result.file;
    result.status = 'rejected';
    result.reason = `too many posters of this batch show people prominently (${prominentOnes.length}, at most ${cap}): ${result.people?.description ?? ''}`;
    log(`${result.postId}: rejected, ${result.reason}`);
  }
  // Every concept is remembered, the rejected ones too, so that next week does not repeat them.
  if (director && input.brandDir) {
    await saveConceptHistory(input.brandDir, past, report.results.flatMap((r) => (r.concept ? [{ at: report.generatedAt, postId: `${input.brandSlug}-${r.postId}`, concept: r.concept.concept, typography: r.concept.typography, people: r.concept.people, accepted: r.status === 'accepted' }] : [])));
  }
  // The brand remembers the looks it just asked for, so its next posters steer clear of them.
  if (input.brandDir) await saveTypeHistory(input.brandDir, pastLeans, newLeans);
  await writeFile(join(outDir, 'creative-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  ai.usage.network = null;
  return report;
}
