/**
 * Website in, scheduled Instagram posts out.
 *
 *   node src/autopilot.ts --site example.com --channel their_insta [--days 7] [--time 10:00]
 *                         [--weekdays mon,wed,fri] [--start YYYY-MM-DD] [--utc-offset +05:30] [--image-model zimage]
 *                         [--refresh-brand] [--dry-run] [--target scheduler|publisher]
 *                         [--art] [--semantic-check] [--review [--review-budget 0.015]] [--allow-paid-ai]
 *
 * First run for a site builds brands/<slug>/brand.json from the website. Every run writes the
 * next week-NN.json with new pain points (history.json prevents repeats) and renders the posters.
 * Unless --dry-run, posts then go to the target: "scheduler" queues them in the local scheduler
 * app (needs --channel); "publisher" exports them to the Vercel publisher folder.
 *
 * --art adds art direction (a separate model call per plan, measured rendering, review before scheduling). It only runs
 * when the brand's art.json enables it, is switched off by ART_DIRECTION_DISABLED=1, and needs --allow-paid-ai with --dry-run.
 * Art-directed posters wait for `node src/art-review.ts ... --approve` before they are scheduled or exported.
 * --plan-only stops after the posts are written (no art direction, pictures or rendering), for a renderer that works from the plan on its own.
 * --review (needs --art) has a vision model look at each finished poster, repairs what can be repaired without a new picture, and rejects the rest
 * (see review-loop.ts). It never approves anything. --review-budget caps what review and repair may spend per batch, in dollars.
 */
import { loadFacts } from './evidence-pipeline.ts';
import { applyReview, loadReview } from './fact-review.ts';
import { modelJudge, modelPictureJudge, modelWorthJudge } from './semantic-judge.ts';
import { effectiveTotal, loadWorth, MIN_WORTH, saveWorth, scoreFacts, WORTH_VERSION, type WorthScore } from './worth.ts';
import { offerableFacts, rankFacts } from './fact-assignment.ts';
import { fileCache } from './semantic-verifier.ts';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { aiConfigFromEnv } from './ai.ts';
import { appendUsageLog } from './usage.ts';
import { CrawlError } from './crawl.ts';
import { makeCreatives } from './ai-creative-pipeline.ts';
import { modelReviewDeps, ordinaryChecks } from './copy-review.ts';
import { registerForReview } from './review-register.ts';
import { displayFact } from './evidence.ts';
import { checkBrandIdentity, checkEvidence, checkLanguage, PreflightError } from './site-preflight.ts';
import { BudgetError, budgetLimitsFromEnv, PaidLedger } from './paid-ledger.ts';
import { analyzeSite, slugFromSite } from './analyze.ts';
import { parseWeekdays } from './cadence.ts';
import { parseBrand, parseWeekPlan, readJson, type WeekPlan } from './content.ts';
import { acquireTenantLock, artDirectPlan, assertArtAllowed, loadArtSettings, readArtHistory, writeFileAtomic, type ArtHistoryEntry, type ArtTenantSettings } from './art-pipeline.ts';
import { recordRenderedArt } from './art-review.ts';
import { reviewAndRepair } from './review-loop.ts';
import { ensureSiteAssets } from './site-assets.ts';
import { exportToPublisher } from './export-publisher.ts';
import { envFilePath, loadEnvIfPresent } from './platform.ts';
import { normalizeHeadline } from './hooks.ts';
import type { ConceptRecord } from './concepts.ts';
import { conceptRecordOf, planWeek } from './planner.ts';
import { createArtRenderContext, renderPlan, type PostRenderRecord } from './render.ts';
import { DEFAULT_SCHEDULER_URL, schedulePlan } from './schedule.ts';

const BRANDS_ROOT = resolve('brands');
const OUT_ROOT = resolve('out');
const WEEK_FILE = /^week-(\d+)\.json$/;

interface History {
  weeks: Array<{ file: string; createdAt: string; painPoints: string[]; /** The pillar of each post; weeks written before pillars have none. */ pillars?: string[]; /** The hook actually used by each post, and its headline as compared for repetition. */ hooks?: string[]; headlines?: string[]; /** The concept of each accepted post, for the repeat check. */ concepts?: ConceptRecord[]; /** The evidence facts assigned to the week's posts, for the fact cooldown. */ factIds?: string[]; /** The art records of rendered posters and where their review stands. */ art?: ArtHistoryEntry[] }>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readHistory(path: string): Promise<History> {
  if (!(await fileExists(path))) return { weeks: [] };
  return JSON.parse(await readFile(path, 'utf8')) as History;
}

async function nextWeekNumber(brandDir: string): Promise<number> {
  const numbers = (await readdir(brandDir)).map((f) => Number(f.match(WEEK_FILE)?.[1] ?? 0));
  return Math.max(0, ...numbers) + 1;
}

/** Day after a YYYY-MM-DD date. */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The local date of the latest post across all saved plans, or null when there are none. */
async function lastPlannedDate(brandDir: string): Promise<string | null> {
  let latest: string | null = null;
  for (const file of await readdir(brandDir)) {
    if (!WEEK_FILE.test(file)) continue;
    const plan = parseWeekPlan(await readJson(join(brandDir, file)), file);
    for (const post of plan.posts) {
      // Dates carry their own offset, so the first 10 characters are the local calendar date.
      const localDate = post.date.slice(0, 10);
      if (!latest || localDate > latest) latest = localDate;
    }
  }
  return latest;
}

/** Continue right after the last planned post, but never earlier than tomorrow. */
export function chooseStartDate(lastPlanned: string | null, tomorrow: string): string {
  if (!lastPlanned) return tomorrow;
  const afterLast = nextDay(lastPlanned);
  return afterLast > tomorrow ? afterLast : tomorrow;
}

/** Tomorrow's date (YYYY-MM-DD) in the given UTC offset. */
export function tomorrowAt(utcOffset: string, now = new Date()): string {
  const sign = utcOffset.startsWith('-') ? -1 : 1;
  const [hours = 0, minutes = 0] = utcOffset.slice(1).split(':').map(Number);
  const local = new Date(now.getTime() + sign * (hours * 60 + minutes) * 60_000 + 86_400_000);
  return local.toISOString().slice(0, 10);
}

function requireEnv(name: string, envPath: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (looked in the environment and in ${envPath})`);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      channel: { type: 'string' },
      days: { type: 'string', default: '7' },
      weekdays: { type: 'string' },
      time: { type: 'string', default: '10:00' },
      start: { type: 'string' },
      'utc-offset': { type: 'string', default: '+05:30' },
      'image-model': { type: 'string' },
      env: { type: 'string' },
      'scheduler-url': { type: 'string', default: DEFAULT_SCHEDULER_URL },
      'refresh-brand': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      art: { type: 'boolean', default: false },
      route: { type: 'string', default: 'ai' },
      'semantic-check': { type: 'boolean', default: false },
      review: { type: 'boolean', default: false },
      'plan-only': { type: 'boolean', default: false },
      'review-budget': { type: 'string', default: '0.015' },
      'allow-paid-ai': { type: 'boolean', default: false },
      target: { type: 'string', default: 'scheduler' },
      publisher: { type: 'string', default: '../../publisher' },
    },
  });
  if (!values.site) throw new Error('Usage: --site <website> --channel <instagram username> [--days 7] [--dry-run]');
  const route = values.route;
  if (route !== 'ai' && route !== 'template') throw new Error('--route must be "ai" (the model draws the whole poster) or "template" (our own layout with an AI picture)');
  const target = values.target;
  const reviewBudget = Number(values['review-budget']);
  if (!Number.isFinite(reviewBudget) || reviewBudget <= 0) throw new Error('--review-budget must be a positive number of dollars');
  if (values.review && !values.art) throw new Error('--review looks at art-directed posters, so it needs --art');
  if (values.review && values['dry-run'] && !values['allow-paid-ai']) throw new Error('--review makes a vision request per poster: with --dry-run it needs --allow-paid-ai');
  if (target !== 'scheduler' && target !== 'publisher') throw new Error('--target must be "scheduler" or "publisher"');
  if (target === 'scheduler' && !values.channel && !values['dry-run']) {
    throw new Error('--channel is required for --target scheduler unless --dry-run is set');
  }
  const weekdays = values.weekdays ? parseWeekdays(values.weekdays.split(',')) : undefined;
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('--days must be a whole number from 1 to 31');

  const envPath = envFilePath(values.env, process.env);
  loadEnvIfPresent(envPath);
  const ai = aiConfigFromEnv(process.env);
  if (values['image-model']) ai.pollinationsImageModel = values['image-model'];
  console.log(`AI: ${ai.primary === 'openai' ? `OpenAI (${ai.textModel} for text, ${ai.imageModel} at ${ai.imageQuality} quality for pictures)` : 'Pollinations'}${ai.fallback ? ', with the other provider as backup' : ''}`);

  const slug = slugFromSite(values.site);
  // Every OpenAI call of this run is reserved against the budget caps before it is sent and recorded after (paid-ledger.ts). The file is shared by
  // all brands, so the daily caps hold across them; a run that hits a cap stops buying and keeps what it already made.
  ai.ledger = new PaidLedger(resolve(process.env['PAID_LEDGER_FILE'] || join(BRANDS_ROOT, '..', 'ledger', 'paid-calls.jsonl')), budgetLimitsFromEnv(process.env), { jobId: `${slug}-${Date.now()}`, tenantId: 'owner', brandId: slug });
  let brandDir = join(BRANDS_ROOT, slug);
  // Art direction is checked before anything paid happens, so a refusal costs nothing.
  let artSettings: ArtTenantSettings | undefined;
  if (values.art && route === 'template') {
    artSettings = await loadArtSettings(brandDir);
    assertArtAllowed({ settings: artSettings, env: process.env, dryRun: values['dry-run'], allowPaidAi: values['allow-paid-ai'] });
  }
  if (values['refresh-brand'] || !(await fileExists(join(brandDir, 'brand.json')))) {
    console.log(`1/4 Reading ${values.site} and building the brand profile…`);
    ai.usage.purpose = 'profile';
    brandDir = (await analyzeSite(values.site, BRANDS_ROOT, ai)).dir;
  } else {
    console.log(`1/4 Using saved brand profile ${join('brands', slug, 'brand.json')}`);
  }
  // A website link is all a run needs: the facts the site states and its icon are gathered here when the brand lacks them (one crawl, no picture is bought).
  await ensureSiteAssets({ brandDir, site: values.site, ai, log: (m) => console.log(`    ${m}`) });
  const brand = parseBrand(await readJson(join(brandDir, 'brand.json')), 'brand.json');
  const releaseLock = artSettings ? await acquireTenantLock(brandDir) : undefined;
  try {

    const historyPath = join(brandDir, 'history.json');
    const history = await readHistory(historyPath);
    const weekNumber = await nextWeekNumber(brandDir);
    const planFile = `week-${String(weekNumber).padStart(2, '0')}.json`;
    const startDate =
      values.start ?? chooseStartDate(await lastPlannedDate(brandDir), tomorrowAt(values['utc-offset']));
    const pattern = weekdays ? ` on ${weekdays.join('/')}` : '';
    ai.usage.purpose = 'writing';
    console.log(`2/4 Writing ${days} new pain-point posts${pattern} from ${startDate} (${planFile})…`);
    const loaded = await loadFacts(brandDir);
    const reviewed = loaded ? applyReview(loaded.facts.filter((f) => f.status === 'usable'), await loadReview(brandDir)) : undefined;
    if (loaded && reviewed) console.log(`    Evidence facts: ${loaded.facts.filter((f) => f.status === 'usable').length} usable of ${loaded.facts.length} (built ${loaded.file.builtAt.slice(0, 10)}); ${reviewed.mode === 'approved_only' ? `${reviewed.approved} approved by the owner are used` : 'none approved yet, all usable are eligible'}.`);
    else console.log('    No evidence facts for this brand: writing from the profile\'s proof points (legacy evidence coverage).');
    // Before anything is written or bought for this run: the site must be supported, the profile must be about it, and there must be a fact to write from.
    if (loaded) {
      const sample = loaded.file.snapshots.map((snap) => snap.text).join('\n').slice(0, 6000);
      const declared = loaded.facts.map((f) => f.language).find((l) => l !== '');
      const findings = [
        checkLanguage(sample, declared),
        checkBrandIdentity({ name: brand.name, site: brand.website || values.site, pageText: sample, titles: loaded.file.snapshots.map((snap) => snap.title) }),
        checkEvidence(reviewed?.facts.length ?? 0),
      ].flatMap((f) => (f ? [f] : []));
      const stop = findings.find((f) => f.severity === 'stop');
      if (stop) throw new PreflightError(stop);
      for (const warning of findings) console.log(`    WARNING ${warning.code}: ${warning.reason}`);
      // A business that could not be confirmed gets no purchased picture; the poster still renders with the verified name and its own text.
      if (findings.some((f) => f.code === 'BRAND_UNVERIFIED')) ai.ledger?.disablePictures();
    }
    if (values['semantic-check'] && values['dry-run'] && !values['allow-paid-ai']) throw new Error('--semantic-check makes one model request per batch of posts: with --dry-run it needs --allow-paid-ai');
    const verdicts = values['semantic-check'] ? await fileCache(join(brandDir, 'semantic-verdicts.json')) : undefined;
    // Poster-worthiness: the best candidates are judged once (a few hundred tokens) and the scores are kept, so a fact is never judged twice.
    let worthScores: Record<string, WorthScore> | undefined;
    if (values['semantic-check'] && reviewed) {
      const worthFile = await loadWorth(brandDir);
      const candidates = rankFacts(offerableFacts(reviewed.facts), history.weeks.flatMap((w) => w.factIds ?? [])).slice(0, 40);
      const result = await scoreFacts(candidates, worthFile.scores, modelWorthJudge(ai));
      if (result.judged > 0) await saveWorth(brandDir, { version: WORTH_VERSION, scores: result.scores });
      if (result.failure) console.log(`    Poster-worthiness could not be judged (${result.failure}); facts are used unscored.`);
      else console.log(`    Poster-worthiness: ${candidates.filter((f) => (result.scores[f.id] ? effectiveTotal(result.scores[f.id] as WorthScore) : 0) >= MIN_WORTH).length} of ${candidates.length} top candidates are worth a post of their own.`);
      worthScores = result.failure ? undefined : result.scores;
    }
    const plan = await planWeek({
      ai,
      compositionHints: process.env['IMAGE_COMPOSITION_HINT'] === '1',
      brand,
      brandSlug: slug,
      weekNumber,
      log: (m) => console.log(`    ${m}`),
      schedule: {
        startDate,
        time: values.time,
        utcOffset: values['utc-offset'],
        count: days,
        ...(weekdays ? { weekdays } : {}),
      },
      usedPainPoints: history.weeks.flatMap((w) => w.painPoints),
      recentPillars: history.weeks.flatMap((w) => w.pillars ?? []),
      recentHooks: history.weeks.flatMap((w) => w.hooks ?? []),
      recentHeadlines: history.weeks.flatMap((w) => w.headlines ?? []),
      recentConcepts: history.weeks.flatMap((w) => w.concepts ?? []),
      ...(verdicts ? { copyJudge: { judge: modelJudge(ai), cache: verdicts } } : {}),
      // The fully AI route writes more candidates than posts and reviews each with structured verdicts before any picture is bought.
      ...(route === 'ai' && reviewed ? { candidates: { review: modelReviewDeps(ai, ordinaryChecks(brand.name)) } } : {}),
      ...(reviewed ? { evidence: { facts: reviewed.facts, recentFactIds: history.weeks.flatMap((w) => w.factIds ?? []), ...(worthScores ? { worth: Object.fromEntries(Object.entries(worthScores).map(([id, sc]) => [id, effectiveTotal(sc)])) } : {}) } } : {}),
    });
    await verdicts?.save();
    if (plan.candidateReport) {
      await writeFileAtomic(join(brandDir, `candidates-${planFile}`), `${JSON.stringify(plan.candidateReport, null, 2)}\n`);
      // Candidates that passed review but were not chosen wait as drafts; before any is used it must pass every check again.
      if (plan.reserveDrafts && plan.reserveDrafts.length > 0) await writeFileAtomic(join(brandDir, 'reserve-drafts.json'), `${JSON.stringify({ savedAt: new Date().toISOString(), plan: planFile, note: 'drafts only: re-run freshness, claim, cooldown and novelty checks before any is used', drafts: plan.reserveDrafts }, null, 2)}\n`);
    }
    console.log(`    Evidence coverage: ${plan.evidenceCoverage ?? 'legacy'}${verdicts ? (plan.evidenceCoverage === 'facts' ? ', copy checked against its facts by a model' : ' (the semantic check needs evidence facts and was not used)') : ''}.`);
    if (plan.insufficientConcepts) {
      const { requested, produced, reasons } = plan.insufficientConcepts;
      console.log(`    Only ${produced} of ${requested} posts: the rest were left out (a repeated idea, or copy the claim gate would not allow).\n    ${reasons.join('\n    ')}`);
    }
    // A fully AI plan is marked so that nothing can publish from it except an approved version in the review queue.
    let finalPlan: WeekPlan = route === 'ai' ? { ...plan, renderMode: 'ai_v1' } : plan;
    if (artSettings && !values['plan-only']) {
      console.log('2b/4 Art direction (one batched model call)…');
      const directed = await artDirectPlan({ ai, plan, brand, history: readArtHistory(history), settings: artSettings, ...(loaded ? { facts: loaded.facts } : {}), ...(values['semantic-check'] ? { pictureJudge: modelPictureJudge(ai) } : {}) });
      finalPlan = directed.plan;
      const { counts, flags, requests, status } = directed.report;
      console.log(`    ${status}: ${counts.directed} directed, ${counts.repaired} repaired, ${counts.fallback} fell back, ${counts.failed} without art direction (${requests} request${requests === 1 ? '' : 's'}).`);
      for (const flag of flags) console.log(`    FLAG: ${flag}`);
      await writeFileAtomic(join(brandDir, `art-report-${planFile}`), `${JSON.stringify(directed.report, null, 2)}\n`);
    }
    await writeFileAtomic(join(brandDir, planFile), `${JSON.stringify(finalPlan, null, 2)}\n`);
    history.weeks.push({ file: planFile, createdAt: new Date().toISOString(), painPoints: plan.posts.map((p) => p.painPoint), pillars: plan.posts.map((p) => p.pillar ?? 'problem'), hooks: plan.posts.map((p) => p.hook ?? 'direct_statement'), headlines: plan.posts.map((p) => normalizeHeadline(p.headline)), concepts: plan.posts.flatMap((p) => conceptRecordOf(p) ?? []), ...(plan.posts.some((p) => p.factIds) ? { factIds: plan.posts.flatMap((p) => p.factIds ?? []) } : {}) });
    await writeFileAtomic(historyPath, `${JSON.stringify(history, null, 2)}\n`);

    if (route === 'ai' && !values['plan-only']) {
      if (values['dry-run'] && !values['allow-paid-ai']) throw new Error('fully AI posters make paid picture and vision calls: with --dry-run they need --allow-paid-ai');
      console.log('3/4 Drawing the posters with the picture model (no template)…');
      const outDir = join(OUT_ROOT, slug, `${planFile.replace(/\.json$/, '')}-ai`);
      const factText = (id: string): string | undefined => { const fact = loaded?.facts.find((f) => f.id === id); return fact ? displayFact(fact) : undefined; };
      ai.usage.purpose = 'writing';
      const made = await makeCreatives({
        ai, brand, brandSlug: slug, brandDir, posts: finalPlan.posts, outDir, log: (m) => console.log(`    ${m}`),
        factOf: (post) => (post.factIds ?? []).map(factText).filter((t): t is string => t !== undefined).join(' ') || post.anchor || post.painPoint,
      });
      const counts = made.results.reduce<Record<string, number>>((sum, r) => ({ ...sum, [r.status]: (sum[r.status] ?? 0) + 1 }), {});
      console.log(`    Posters: ${made.results.filter((r) => r.status === 'accepted').length} accepted of ${finalPlan.posts.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}). Report: ${join(outDir, 'creative-report.json')}`);
      if (made.stoppedBy) console.log(`    STOPPED: ${made.stoppedBy}`);
      console.log(ai.usage.format());
      const log = process.env['USAGE_LOG_FILE'];
      if (log) await appendUsageLog(log, ai.usage.records(slug, finalPlan.posts.map((p) => `${slug}-${p.id}`)));
      const queued = registerForReview({ brandDir, brandSlug: slug, planFile, report: made, posts: finalPlan.posts, brand, facts: loaded?.facts ?? [], reportFile: join(outDir, 'creative-report.json') });
      console.log(`    ${queued.length} poster${queued.length === 1 ? '' : 's'} added to the owner's review queue.`);
      console.log('4/4 Nothing was scheduled or published: every poster waits for the owner to approve it.');
      return;
    }
    if (values['plan-only']) {
      console.log(`Plan only: ${planFile} is written with its copy and facts; no picture was made and nothing was rendered. ${ai.usage.format()}`);
      return;
    }
    console.log('3/4 Rendering posters…');
    let outDir: string;
    try {
      outDir = await renderPlan({
        brandDir,
        planFile,
        ai,
        log: (m) => console.log(`    ${m}`),
        artFailure: artSettings?.fallbackToLegacy ? 'legacy' : 'fail',
      });
    } catch (error) {
      console.log(ai.usage.format());
      throw error;
    } finally {
      // Posters that rendered are recorded as awaiting review even when another poster failed.
      if (artSettings) {
        const recorded = await recordRenderedArt({ brandDir, planFile }).catch(() => 0);
        if (recorded > 0) console.log(`    ${recorded} art-directed poster(s) are waiting for review: node src/art-review.ts --brand ${brandDir} --plan ${planFile} --list`);
      }
    }
    if (values.review) {
      const rendered = parseWeekPlan(await readJson(join(brandDir, planFile)), planFile);
      const records = JSON.parse(await readFile(join(outDir, 'render-report.json'), 'utf8')) as PostRenderRecord[];
      const factById = new Map((reviewed?.facts ?? []).map((f) => [f.id, f.text]));
      console.log('3b/4 Reviewing the finished posters…');
      ai.usage.purpose = 'review';
      await reviewAndRepair({
        ai, plan: rendered, planFile, records, budgetUsd: reviewBudget, factText: (id) => factById.get(id),
        ctx: await createArtRenderContext({ brandDir, planFile, ai, log: (m) => console.log(`    ${m}`) }),
        log: (m) => console.log(`    ${m}`),
      });
    }
    console.log(ai.usage.format());
    const usageLog = process.env['USAGE_LOG_FILE'];
    if (usageLog) {
      await appendUsageLog(usageLog, ai.usage.records(slug, plan.posts.map((p) => `${slug}-${p.id}`)));
      console.log(`Cost saved to ${usageLog} for the dashboard.`);
    }

    if (values['dry-run']) {
      console.log(`4/4 Dry run: nothing scheduled. Preview: ${join(outDir, 'preview.html')}`);
      return;
    }
    if (target === 'publisher') {
      console.log('4/4 Exporting to the Vercel publisher…');
      const exported = await exportToPublisher(brandDir, resolve(values.publisher));
      console.log(`Done: ${exported.length} upcoming posts in the publisher (last ${exported.at(-1)?.date ?? '-'}).`);
      return;
    }
    if (!values.channel) throw new Error('--channel is required for --target scheduler');
    console.log(`4/4 Scheduling on ${values.channel}…`);
    const count = await schedulePlan({
      brandDir,
      planFile,
      channel: values.channel,
      schedulerKey: requireEnv('SCHEDULER_API_KEY', envPath),
      schedulerUrl: values['scheduler-url'],
      log: (m) => console.log(`    ${m}`),
    });
    console.log(`Done: ${count} posts scheduled. Preview: ${join(outDir, 'preview.html')}`);
  } finally {
    await releaseLock?.();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof BudgetError) console.error(`BUDGET_EXHAUSTED (${error.code}): ${error.message}. Nothing more was bought; what was already made is kept.`);
    else if (error instanceof CrawlError) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof PreflightError) console.error(`${error.code}: ${error.message}. No posters were made.`);
    else console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
