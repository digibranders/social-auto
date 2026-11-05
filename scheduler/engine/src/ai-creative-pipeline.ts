/**
 * Makes the fully AI poster of each post of a plan, within the spending rules, and records exactly what happened. One post at a time:
 *   attempt 1: the picture model draws the whole poster from the prompt contract, one vision request reads it, and code judges it (ai-creative.ts);
 *   attempt 2: only when attempt 1 was rejected for something a new instruction can fix, with the defects written into the prompt.
 * A poster that is rejected twice, or whose budget is spent, is dropped: fewer posters, never a poster that did not pass. An accepted poster is only
 * "pending": nothing here approves, schedules or publishes anything.
 */
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { generateScene } from './ai.ts';
import { buildCreativePrompt, displayDomain, isRecoverable, judgeReadings, plainHeadline, retryNoteFor, reviewCreative, type CreativeDefect, type CreativeReview, type TextManifest } from './ai-creative.ts';
import type { Brand, PlannedPost } from './content.ts';
import { BudgetError } from './paid-ledger.ts';
import { batchLookAlikes, compareIdeas, directBatch, loadConceptHistory, openAiEmbedder, saveConceptHistory, type DirectorResult, type LookAlikes, type PlannedConcept } from './creative-director.ts';

export interface CreativeAttempt {
  n: number;
  prompt: string;
  imageFile: string;
  /** Every independent reading of the poster; it must pass all of them. */
  readings: CreativeReview[];
  accepted: boolean;
  defects: CreativeDefect[];
  /** The failure that ended this attempt before it could be judged, when there was one. */
  error?: string;
}

export interface CreativeResult {
  postId: string;
  manifest: TextManifest;
  status: 'accepted' | 'rejected' | 'budget_stopped' | 'failed' | 'dropped';
  /** The picture the creative director chose for this post. */
  concept?: PlannedConcept;
  /** The file of the accepted poster. */
  file?: string;
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
}

export interface CreativeDeps {
  /** For tests: replaces the picture call. */
  scene?: (prompt: string, outPath: string) => Promise<void>;
  /** For tests: replaces the vision call. */
  review?: (imagePath: string, message: string, reading: number) => Promise<CreativeReview>;
  /** How many independent readings a poster must pass. */
  readings?: number;
  /** For tests: replaces the creative director (concepts for the batch). */
  direct?: (posts: ReadonlyArray<{ id: string; headline: string; fact: string }>, history: readonly string[]) => Promise<DirectorResult>;
  /** For tests: replaces the side-by-side check of the finished posters. */
  lookAlikes?: (posters: ReadonlyArray<{ id: string; file: string }>) => Promise<LookAlikes>;
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

export const manifestOf = (post: PlannedPost, brand: Brand): TextManifest => ({ headline: plainHeadline(post.headline), brandName: brand.name, domain: displayDomain(brand.website) });

export async function makeCreatives(input: CreativeRunInput): Promise<CreativeReport> {
  const { ai, brand, posts, outDir, deps = {} } = input;
  const log = input.log ?? (() => undefined);
  const maxAttempts = deps.maxAttempts ?? 2;
  await mkdir(outDir, { recursive: true });
  const report: CreativeReport = { brand: input.brandSlug, generatedAt: (deps.now?.() ?? new Date()).toISOString(), results: [] };

  const scene = deps.scene ?? (async (prompt: string, outPath: string): Promise<void> => {
    await generateScene(ai, { prompt, outPath, width: 1024, height: 1024, seed: 1 }, { openaiImages: 0 });
  });
  const look = deps.review ?? ((imagePath: string, message: string, reading: number): Promise<CreativeReview> => reviewCreative(ai, imagePath, message, undefined, reading, allowedTexts));
  const readings = deps.readings ?? 2;
  let allowedTexts: string[] = [];
  const spent = (postId: string): number => ai.ledger?.spend(postId).poster ?? 0;

  // The creative director (when it is switched on) plans every post of the batch together, and the plan is checked, before any picture is bought.
  const director = input.directorEnabled === true;
  const past = director && input.brandDir ? await loadConceptHistory(input.brandDir) : [];
  const batch = posts.map((post) => ({ id: post.id, headline: plainHeadline(post.headline), fact: input.factOf(post) }));
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
      for (const post of posts) report.results.push({ postId: post.id, manifest: manifestOf(post, brand), status: 'budget_stopped', attempts: [], reason: error.message, costUsd: 0 });
      await writeFile(join(outDir, 'creative-report.json'), `${JSON.stringify(report, null, 2)}\n`);
      return report;
    }
    // Without a plan no picture is bought: the model is never left to pick the same default scene four times.
    const reason = `the creative director could not plan the batch: ${error instanceof Error ? error.message : String(error)}`;
    for (const post of posts) report.results.push({ postId: post.id, manifest: manifestOf(post, brand), status: 'failed', attempts: [], reason, costUsd: 0 });
    await writeFile(join(outDir, 'creative-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  if (director) report.direction = { flags: direction.flags, dropped: direction.dropped };
  const conceptOf = new Map(direction.concepts.map((c) => [c.postId, c]));

  for (const post of posts) {
    const manifest = manifestOf(post, brand);
    const fact = input.factOf(post);
    allowedTexts = [manifest.headline, ...(manifest.subline ? [manifest.subline] : []), manifest.brandName, manifest.domain];
    const result: CreativeResult = { postId: post.id, manifest, status: 'rejected', attempts: [], costUsd: 0 };
    report.results.push(result);
    const concept = conceptOf.get(post.id);
    if (director && !concept) {
      result.status = 'dropped';
      result.reason = direction.dropped.find((d) => d.postId === post.id)?.reason ?? 'the creative director gave this post no concept';
      log(`${post.id}: dropped (${result.reason})`);
      continue;
    }
    if (concept) result.concept = concept;
    ai.usage.post = `${input.brandSlug}-${post.id}`;
    // The ledger counts a poster's calls under the same id.
    const ledgerId = ai.usage.post;
    let note: string | undefined;
    try {
      for (let n = 1; n <= maxAttempts; n++) {
        const imageFile = join(outDir, `${post.id}.attempt${n}.jpg`);
        const prompt = buildCreativePrompt(manifest, { fact, colors: brand.colors, ...(concept ? { concept: { concept: concept.concept, factToPicture: concept.factToPicture, typography: concept.typography } } : {}), ...(note ? { retryNote: note } : {}) });
        const attempt: CreativeAttempt = { n, prompt, imageFile, readings: [], accepted: false, defects: [] };
        result.attempts.push(attempt);
        log(`${post.id}: attempt ${n}, drawing the poster…`);
        try {
          await scene(prompt, imageFile);
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
        const verdict = judgeReadings(manifest, attempt.readings);
        attempt.accepted = verdict.accepted;
        attempt.defects = verdict.defects;
        if (verdict.accepted) {
          const file = join(outDir, `${post.id}.jpg`);
          await copyFile(imageFile, file);
          result.status = 'accepted';
          result.file = file;
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
  // Every concept is remembered, the rejected ones too, so that next week does not repeat them.
  if (director && input.brandDir) {
    await saveConceptHistory(input.brandDir, past, report.results.flatMap((r) => (r.concept ? [{ at: report.generatedAt, postId: `${input.brandSlug}-${r.postId}`, concept: r.concept.concept, typography: r.concept.typography, people: r.concept.people, accepted: r.status === 'accepted' }] : [])));
  }
  await writeFile(join(outDir, 'creative-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
