/**
 * EXPERIMENT: complete posters made by the image model with no layout template, compared with the posters the production renderer made for the same
 * verified facts and approved headlines. Not called by autopilot, publishes nothing, and writes only under out/<brand>/<plan>-ai/.
 *
 *   node src/ai-poster-test.ts --brand brands/digibranders --plan week-04.json                    # plan only: prompts and estimated cost, no model call
 *   node src/ai-poster-test.ts --brand brands/digibranders --plan week-04.json --live --allow-paid-ai [--posts w04-d2,w04-d3] [--max-usd 0.40] [--quality high]
 *
 * With --hybrid the model makes the artwork and headline only and code adds the brand's real mark (the symbol alone when the brand has a confirmed icon, see
 * brand-icon.ts) and the call to action; a poster whose text is not exactly the approved headline is rejected before anything is composited, and the vision review of the finished poster decides the rest.
 * A live run makes one picture request per post, one vision request to read the text on it, and one vision review of it and of the production poster. It stops
 * before any request that would take the run past --max-usd.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { aiConfigFromEnv, type AiConfig, type ImageBudget, type ImageQuality } from './ai.ts';
import { buildFullPosterPrompt, compareText, estimatePosterCost, generateFullPoster, logoReferenceType, readPosterText, type FullPosterInput, type TextCheck } from './ai-poster.ts';
import { captureHtml } from './chrome-render.ts';
import { loadFacts } from './evidence-pipeline.ts';
import { parseBrand, parseWeekPlan, readJson, type PlannedPost } from './content.ts';
import { envFilePath, loadEnvIfPresent } from './platform.ts';
import { reviewPosters, ReviewBudget, type PosterReview } from './poster-review.ts';
import { buildHybridPrompt, captureHybrid, categorize, CTA_ZONE, hybridTextCheck, LOGO_ZONE, measurePlainness, rejectionReasons, zoneWarnings, type RejectionCategory } from './ai-poster-hybrid.ts';
import { chooseLogoMark } from './logo-assets.ts';
import { measureLogoTone } from './logo-tone.ts';

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

export interface ExperimentPost {
  id: string;
  input: FullPosterInput;
  prompt: string;
}

/** The plan of the experiment for the chosen posts: what each prompt says and what it should cost. Pure; no model is called. */
export function planExperiment(input: { posts: readonly PlannedPost[]; factText: (id: string) => string | undefined; brand: { name: string; handleUrl?: string; colors: { background: string; ink: string; accent: string } }; hasLogoReference: boolean }): ExperimentPost[] {
  return input.posts.map((post) => {
    const fact = (post.factIds ?? []).map(input.factText).find((t) => t) ?? post.headline.replaceAll('|', '');
    const posterInput: FullPosterInput = {
      headline: post.headline.replaceAll('|', ''),
      ...(post.subline?.trim() ? { subline: post.subline.replaceAll('|', '') } : {}),
      fact,
      brandName: input.brand.name,
      colors: input.brand.colors,
      ...(input.brand.handleUrl ? { host: input.brand.handleUrl } : {}),
      hasLogoReference: input.hasLogoReference,
    };
    return { id: post.id, input: posterInput, prompt: buildFullPosterPrompt(posterInput) };
  });
}

/** A logo picture the image endpoint accepts: a raster logo as it is, an SVG drawn onto a white square in Chrome. Undefined when there is none. */
async function logoReference(logoPath: string, workDir: string): Promise<string | undefined> {
  if (!(await exists(logoPath))) return undefined;
  if (logoReferenceType(logoPath)) return logoPath;
  if (extname(logoPath).toLowerCase() !== '.svg') return undefined;
  const out = join(workDir, 'logo-reference.png');
  const svg = (await readFile(logoPath, 'utf8')).replace(/<\?xml[^>]*>/, '');
  await captureHtml(`<!doctype html><html><body style="margin:0;width:1080px;height:1080px;background:#fff;display:flex;align-items:center;justify-content:center"><div style="width:800px">${svg}</div></body></html>`, out);
  return out;
}

export interface ExperimentResult {
  postId: string;
  headline: string;
  prompt: string;
  aiPoster?: string;
  productionPoster?: string;
  text?: TextCheck;
  aiReview?: Pick<PosterReview, 'observed' | 'scores' | 'defects'> & { decision: string };
  productionReview?: Pick<PosterReview, 'observed' | 'scores' | 'defects'> & { decision: string };
  /** Hybrid mode: the poster with the real mark and button added, and why a poster was rejected (an empty list means accepted). */
  finalPoster?: string;
  rejected?: string[];
  rejectionCategories?: RejectionCategory[];
  zoneWarnings?: string[];
  plainness?: { logo: number; cta: number };
  skipped?: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { brand: { type: 'string' }, plan: { type: 'string' }, posts: { type: 'string' }, live: { type: 'boolean', default: false }, 'allow-paid-ai': { type: 'boolean', default: false }, 'max-usd': { type: 'string' }, quality: { type: 'string' }, env: { type: 'string' }, count: { type: 'string', default: '4' }, hybrid: { type: 'boolean', default: false } },
  });
  if (!values.brand || !values.plan) throw new Error('Usage: --brand <dir> --plan <week-NN.json> [--posts id,id] [--count 4] [--live --allow-paid-ai] [--max-usd 0.40] [--quality low|medium|high]');
  const brandDir = resolve(values.brand);
  const brand = parseBrand(await readJson(join(brandDir, 'brand.json')), 'brand.json');
  const plan = parseWeekPlan(await readJson(join(brandDir, values.plan)), values.plan);
  const wanted = values.posts ? values.posts.split(',').map((s) => s.trim()) : plan.posts.map((p) => p.id).slice(0, Number(values.count));
  const posts = wanted.map((id) => plan.posts.find((p) => p.id === id)).filter((p): p is PlannedPost => p !== undefined);
  if (posts.length === 0) throw new Error('no post of that plan was chosen');
  const loaded = await loadFacts(brandDir);
  const factById = new Map((loaded?.facts ?? []).map((f) => [f.id, f.text]));
  const outDir = resolve('out', basename(brandDir), `${basename(values.plan, '.json')}-${values.hybrid ? 'hybrid' : 'ai'}`);
  const baselineDir = resolve('out', basename(brandDir), basename(values.plan, '.json'));
  const logoPath = join(brandDir, brand.logo);
  const hasLogo = await exists(logoPath);
  const experiment = planExperiment({ posts, factText: (id) => factById.get(id), brand: { name: brand.name, ...(brand.handleUrl ? { handleUrl: brand.handleUrl } : {}), colors: brand.colors }, hasLogoReference: hasLogo });

  const quality = (values.quality ?? 'medium') as ImageQuality;
  if (!['low', 'medium', 'high'].includes(quality)) throw new Error('--quality must be low, medium or high');
  const perPoster = estimatePosterCost({ imageQuality: quality });
  console.log(`Experiment: complete AI posters for ${experiment.length} post${experiment.length === 1 ? '' : 's'} of ${values.plan} (${brand.name}). Estimated picture cost about $${(perPoster * experiment.length).toFixed(3)} at ${quality} quality, plus about $0.003 per post to read and review.`);
  const promptFor = (post: ExperimentPost): string => (values.hybrid ? buildHybridPrompt({ headline: post.input.headline, ...(post.input.subline ? { subline: post.input.subline } : {}), fact: post.input.fact, colors: post.input.colors }) : post.prompt);
  for (const post of experiment) console.log(`\n${post.id}: ${post.input.headline}\n  prompt: ${promptFor(post)}`);
  if (!values.live) {
    console.log('\nPlan only: no model was called and nothing was bought. Add --live --allow-paid-ai to run it.');
    return;
  }
  if (!values['allow-paid-ai']) throw new Error('--live buys pictures: it needs --allow-paid-ai');
  // The hybrid pilot has a lower ceiling by design: a few posters, one attempt each, no regeneration.
  const cap = Number(values['max-usd'] ?? (values.hybrid ? '0.10' : '0.40'));
  if (!Number.isFinite(cap) || cap <= 0) throw new Error('--max-usd must be a positive number of dollars');

  loadEnvIfPresent(envFilePath(values.env, process.env));
  const ai: AiConfig = aiConfigFromEnv(process.env);
  ai.imageQuality = quality;
  if (!ai.openaiKey) throw new Error('a complete AI poster needs an OpenAI key');
  await mkdir(outDir, { recursive: true });
  const reference = hasLogo ? await logoReference(logoPath, outDir) : undefined;
  const budget: ImageBudget = { openaiImages: 0 };
  const money = new ReviewBudget(ai, cap);
  const results: ExperimentResult[] = [];
  const baselineHasPicture = new Map<string, boolean>();
  try {
    const records = JSON.parse(await readFile(join(baselineDir, 'render-report.json'), 'utf8')) as Array<{ postId: string; record?: { pictureRole?: string } }>;
    for (const r of records) baselineHasPicture.set(r.postId, (r.record?.pictureRole ?? 'hero') !== 'none');
  } catch {
    // No render report: the production poster is assumed to have a picture.
  }

  async function runHybrid(post: ExperimentPost): Promise<void> {
    const result = results.find((r) => r.postId === post.id) as ExperimentResult;
    const art = join(outDir, `${post.id}.art.jpg`);
    const hybridInput = { headline: post.input.headline, ...(post.input.subline ? { subline: post.input.subline } : {}) };
    try {
      await generateFullPoster(ai, { prompt: promptFor(post), outPath: art }, budget);
    } catch (error) {
      result.skipped = `not made: ${error instanceof Error ? error.message : String(error)}`;
      console.log(`${post.id}: ${result.skipped}`);
      return;
    }
    result.aiPoster = art;
    try {
      result.text = hybridTextCheck(hybridInput, await readPosterText(ai, art));
    } catch (error) {
      result.skipped = `text not read: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const shares = await measurePlainness(art, [LOGO_ZONE, CTA_ZONE]);
    if (shares) result.plainness = { logo: shares[0] as number, cta: shares[1] as number };
    result.zoneWarnings = zoneWarnings(result.plainness);
    const textReasons = rejectionReasons({ text: result.text, plain: result.plainness }, hybridInput);
    result.rejected = [...textReasons];
    if (textReasons.length > 0) {
      result.rejectionCategories = categorize({ textReasons, defects: [], warnings: [] });
      console.log(`${post.id}: REJECTED before compositing, ${textReasons.join('; ')}`);
      return;
    }
    const mark = chooseLogoMark(brand);
    const markPath = join(brandDir, mark.path);
    const finalPng = join(outDir, `${post.id}.png`);
    await captureHybrid({ imagePath: art, mark: { path: markPath, kind: mark.kind, tone: await measureLogoTone(markPath) }, ...(brand.cta ? { cta: { label: brand.cta.label, host: brand.handleUrl || brand.cta.text } } : {}), colors: { ink: brand.colors.ink, accent: brand.colors.accent } }, finalPng);
    result.finalPoster = finalPng;
    const fact = (planPost(posts, post.id)?.factIds ?? []).map((id) => factById.get(id)).find((t) => t) ?? post.input.headline;
    const productionPath = join(baselineDir, `${post.id}.jpg`);
    const inputs = [{ key: 'ai', imagePath: finalPng, headline: post.input.headline, fact, hasPicture: true }, ...((await exists(productionPath)) ? [{ key: 'production', imagePath: productionPath, headline: post.input.headline, fact, hasPicture: baselineHasPicture.get(post.id) ?? true }] : [])];
    const reviews = await reviewPosters({ ai, posts: inputs, budget: new ReviewBudget(ai, 0.05) });
    for (const [key, outcome] of reviews) {
      if (outcome.status !== 'reviewed') continue;
      const summary = { observed: outcome.review.observed, scores: outcome.review.scores, defects: outcome.review.defects, decision: outcome.review.decision.action };
      if (key === 'ai') result.aiReview = summary;
      else result.productionReview = summary;
    }
    // The reviewer's verdict on the finished poster decides: the reserved areas, the mark's plate and the button are judged where they really are.
    if (result.aiReview && result.aiReview.decision !== 'accept') {
      result.rejectionCategories = categorize({ textReasons: [], defects: result.aiReview.defects, warnings: result.zoneWarnings });
      result.rejected = result.aiReview.defects.map((d) => `${d.code}: ${d.detail}`);
    }
    console.log(`${post.id}: ${result.rejected && result.rejected.length > 0 ? `REJECTED by review (${(result.rejectionCategories ?? []).join(', ')})` : 'accepted'} (${mark.kind} mark); review ${result.aiReview ? JSON.stringify(result.aiReview.scores) : 'none'}; reserved areas: ${result.zoneWarnings?.join('; ') || 'plain'}`);
  }

  for (const post of experiment) {
    const productionPath = join(baselineDir, `${post.id}.jpg`);
    const result: ExperimentResult = { postId: post.id, headline: post.input.headline, prompt: post.prompt, ...((await exists(productionPath)) ? { productionPoster: productionPath } : {}) };
    results.push(result);
    // Before the first picture the table price is used; after it, what pictures really cost in this run (with a margin), plus reading and review.
    const expected = budget.openaiImages > 0 ? (money.spentUsd() / budget.openaiImages) * 1.3 + 0.01 : perPoster * 0.6 + 0.01;
    if (!money.canAfford(expected)) {
      result.skipped = `stopped before this post: the next one would take the run past $${cap.toFixed(2)}`;
      console.log(`${post.id}: ${result.skipped}`);
      continue;
    }
    if (values.hybrid) {
      await runHybrid(post);
      continue;
    }
    const out = join(outDir, `${post.id}.jpg`);
    try {
      await generateFullPoster(ai, { prompt: post.prompt, outPath: out, ...(reference ? { logoPath: reference } : {}) }, budget);
    } catch (error) {
      result.skipped = `not made: ${error instanceof Error ? error.message : String(error)}`;
      console.log(`${post.id}: ${result.skipped}`);
      continue;
    }
    result.aiPoster = out;
    try {
      result.text = compareText({ headline: post.input.headline, ...(post.input.subline ? { subline: post.input.subline } : {}), brandName: post.input.brandName, ...(post.input.host ? { host: post.input.host } : {}) }, await readPosterText(ai, out));
    } catch (error) {
      result.skipped = `text not read: ${error instanceof Error ? error.message : String(error)}`;
    }
    const fact = (planPost(posts, post.id)?.factIds ?? []).map((id) => factById.get(id)).find((t) => t) ?? post.input.headline;
    const reviewInputs = [{ key: 'ai', imagePath: out, headline: post.input.headline, fact, hasPicture: true }, ...(result.productionPoster ? [{ key: 'production', imagePath: result.productionPoster, headline: post.input.headline, fact, hasPicture: baselineHasPicture.get(post.id) ?? true }] : [])];
    const reviews = await reviewPosters({ ai, posts: reviewInputs, budget: new ReviewBudget(ai, 0.05) });
    for (const [key, outcome] of reviews) {
      if (outcome.status !== 'reviewed') continue;
      const summary = { observed: outcome.review.observed, scores: outcome.review.scores, defects: outcome.review.defects, decision: outcome.review.decision.action };
      if (key === 'ai') result.aiReview = summary;
      else result.productionReview = summary;
    }
    console.log(`${post.id}: headline exact ${result.text?.headlineExact ?? 'unread'}; extra words ${result.text?.extraWords.join(' ') || 'none'}; review ${result.aiReview ? JSON.stringify(result.aiReview.scores) : 'none'}`);
  }

  const summary = ai.usage.summary();
  const report = { at: new Date().toISOString(), brand: brand.name, plan: values.plan, quality, capUsd: cap, totalUsd: summary.totalUsd, results };
  await writeFile(join(outDir, 'ai-poster-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(ai.usage.format());
  console.log(`Report: ${join(outDir, 'ai-poster-report.json')}`);
}

const planPost = (posts: readonly PlannedPost[], id: string): PlannedPost | undefined => posts.find((p) => p.id === id);

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
