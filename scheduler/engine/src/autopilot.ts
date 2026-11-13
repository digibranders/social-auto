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
 * --copy-first (AI route) stops after the posts are written and lists them for the owner to keep or drop; nothing is drawn or paid for.
 * --networks instagram,linkedin (AI route) also writes each post a caption for each of those networks (stored as the post's `variants`).
 * --page reads only the address given (one page, no links followed); for a website that has no saved profile yet.
 * --redraw-missing (with --draw-kept) draws again only the kept posts that have no picture yet, after a run that stopped part-way.
 * --draw-kept week-NN.json then draws only the posts the owner kept in that batch, and queues the results for poster review.
 * --plan-only stops after the posts are written (no art direction, pictures or rendering), for a renderer that works from the plan on its own.
 * --review (needs --art) has a vision model look at each finished poster, repairs what can be repaired without a new picture, and rejects the rest
 * (see review-loop.ts). It never approves anything. --review-budget caps what review and repair may spend per batch, in dollars.
 */
import { factsForTopic, isCustomerFact } from './customer-facts.ts';
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
import { assertPublishingEnabled, PublishingDisabledError } from './publishing-switch.ts';
import { makeCreatives } from './ai-creative-pipeline.ts';
import { modelReviewDeps, ordinaryChecks } from './copy-review.ts';
import { COMPOSITOR_READY, assertMayDraw, freezeLogo, logoPathFor, resolveBranding, type BrandingDecision } from './branding.ts';
import { registerForReview } from './review-register.ts';
import { displayFact } from './evidence.ts';
import { checkBrandIdentity, checkEvidence, checkLanguage, PreflightError } from './site-preflight.ts';
import { BudgetError, budgetLimitsFromEnv, PaidLedger } from './paid-ledger.ts';
import { analyzeSite, slugFromSite } from './analyze.ts';
import { ReviewStore } from './review-store.ts';
import { parseWeekdays, weekdayOf } from './cadence.ts';
import { composeCaption, parseBrand, parseWeekPlan, readJson, type PlannedPost, type WeekPlan } from './content.ts';
import { batchLookAlikes } from './creative-director.ts';
import { addNetworkToBatch } from './add-network.ts';
import { CopyStage, CopyStageError, replaceProblem } from './copy-stage.ts';
import { ProductBrands } from './product-brands.ts';
import { ConnectedUnknownError, connectedForDraw, readConnected } from './connected-networks.ts';
import { logoForDraw, placeholderDeps, placeholderEnabled } from './placeholder-pictures.ts';
import { pageModeBlocked } from './page-mode.ts';
import { redrawAlike } from './look-alike-check.ts';
import { classifyNotDrawn, NOT_DRAWN_REASON } from './not-drawn.ts';
import { drawableFactIds, DRAW_FACT_MAX_AGE_DAYS, postsWithOutdatedFacts } from './fact-recheck.ts';
import { weeklyLimitFromEnv } from './picture-limit.ts';
import { composeVariant, isNetwork, NETWORKS, pictureGroups, variantTexts, type Network, type PostVariants } from './networks.ts';
import { writeNetworkCaptions } from './network-captions.ts';
import { headlineGateFromEnv, judgeHeadlines, scoreHeadlines } from './headline-gate.ts';
import { acquireTenantLock, artDirectPlan, assertArtAllowed, loadArtSettings, readArtHistory, writeFileAtomic, type ArtHistoryEntry, type ArtTenantSettings } from './art-pipeline.ts';
import { recordRenderedArt } from './art-review.ts';
import { reviewAndRepair } from './review-loop.ts';
import { ensureSiteAssets } from './site-assets.ts';
import { exportToPublisher } from './export-publisher.ts';
import { envFilePath, loadEnvIfPresent } from './platform.ts';
import { normalizeHeadline } from './hooks.ts';
import type { ConceptRecord } from './concepts.ts';
import { CAPTION_RULES, conceptRecordOf, InsufficientConceptsError, planWeek, scheduleDates, type PlanSchedule } from './planner.ts';
import { topUpPlan } from './plan-topup.ts';
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

class PageModeError extends Error {}
class NothingDrawnError extends Error {}
class PartialDrawError extends Error {}

/** Thrown when a new topic could not be written: nothing is added and nothing is counted. Printed with its code so the job can say so. */
class NothingWrittenError extends Error {}

/**
 * Writes one new post for the day of a dropped post, through the normal writer (the claim gate on the website's facts, the brand-identity check, the headline rules) with every post of the
 * batch given as what it must not repeat, writes its caption for each network, and adds it to the plan file and to the batch. Nothing is drawn and nothing is scheduled.
 */
async function replaceDroppedPost(input: {
  brandDir: string;
  slug: string;
  planFile: string;
  droppedId: string;
  networks: readonly string[];
  time: string;
  utcOffset: string;
  history: Awaited<ReturnType<typeof readHistory>>;
  historyPath: string;
  loaded: Awaited<ReturnType<typeof loadFacts>>;
  writePlan: (schedule: PlanSchedule, over?: Partial<Parameters<typeof planWeek>[0]>) => ReturnType<typeof planWeek>;
  ai: Parameters<typeof writeNetworkCaptions>[0]['ai'];
}): Promise<void> {
  const { brandDir, planFile, droppedId, history } = input;
  const stage = new CopyStage(brandDir, input.slug);
  const batch = stage.get(planFile);
  const today = tomorrowAt('+05:30', new Date(Date.now() - 86_400_000));
  const problem = replaceProblem(batch, droppedId, today);
  if (problem) throw new CopyStageError(problem.code, problem.message);
  const dropped = batch.posts.find((p) => p.postId === droppedId) as { date: string };
  const day = dropped.date;
  const planPath = join(brandDir, planFile);
  const existingPlan = parseWeekPlan(await readJson(planPath), planFile);
  // The new post goes out at the dropped post's own time.
  const dateOf = existingPlan.posts.find((p) => p.id === droppedId)?.date ?? `${day}T${input.time}:00${input.utcOffset}`;
  const clock = /T(\d{2}:\d{2})/.exec(dateOf)?.[1] ?? input.time;
  const existing = existingPlan.posts;
  console.log(`    Writing a new topic for ${day} (${planFile})…`);
  let one: PlannedPost | undefined;
  try {
    const made = await input.writePlan({ startDate: day, time: clock, utcOffset: input.utcOffset, count: 1, weekdays: [weekdayOf(day)] }, {
      // A different request from the batch's own on purpose (the paid-call guard refuses an identical one): the day, and every idea the batch already has, the dropped one included.
      requestNote: `Write ONE post, for ${day}. It must be about a different fact and a different idea from the posts this batch already has: ${existing.slice(0, 40).map((p) => `"${p.headline.replaceAll('|', '')}"`).join('; ')}. ${CAPTION_RULES}`,
      recentHeadlines: [...history.weeks.flatMap((w) => w.headlines ?? []), ...existing.map((p) => p.headline)],
      recentConcepts: [...history.weeks.flatMap((w) => w.concepts ?? []), ...existing.flatMap((p) => { const r = conceptRecordOf(p); return r ? [r] : []; })],
    });
    one = made.posts[0];
  } catch (error) {
    if (!(error instanceof InsufficientConceptsError)) throw error;
  }
  if (one === undefined) throw new NothingWrittenError('no new topic passed the checks for that day, so nothing was added');
  const stem = /^week-(\d{2,4})\.json$/.exec(planFile)?.[1] ?? '00';
  const newId = `w${stem}-r${existing.filter((p) => p.id.startsWith(`w${stem}-r`)).length + 1}`;
  let post: PlannedPost = { ...one, id: newId, date: dateOf };
  if (input.networks.length > 0) {
    console.log(`    Writing a caption for each of ${input.networks.join(', ')}…`);
    const factOf = (id: string): string | undefined => { const fact = input.loaded?.facts.find((f) => f.id === id); return fact ? displayFact(fact) : undefined; };
    const written = await writeNetworkCaptions({ ai: input.ai, networks: input.networks as Network[], posts: [{ id: post.id, headline: post.headline.replaceAll('|', ''), caption: post.caption, hashtags: post.hashtags, facts: (post.factIds ?? []).map(factOf).filter((t): t is string => t !== undefined) }] });
    if (written.variants[post.id]) post = { ...post, variants: written.variants[post.id] as PostVariants };
  }
  // The plan file first: a post in it that the batch never got is harmless (nothing draws a post the batch does not keep), while a batch post with no plan entry could not be drawn.
  await writeFileAtomic(planPath, `${JSON.stringify({ ...existingPlan, posts: [...existingPlan.posts, post] }, null, 2)}\n`);
  stage.addReplacement(planFile, droppedId, { postId: post.id, date: day, headline: post.headline, caption: composeCaption(post), ...(post.variants ? { captions: Object.fromEntries(Object.entries(post.variants).map(([n, v]) => [n, { text: composeVariant(v), ...(v.fallback ? { fallback: true } : {}) }])) } : {}) }, today);
  // What was written is remembered, so a later batch does not repeat it.
  const week = history.weeks.find((w) => w.file === planFile);
  if (week) {
    week.painPoints.push(post.painPoint);
    week.headlines = [...(week.headlines ?? []), normalizeHeadline(post.headline)];
    const concept = conceptRecordOf(post);
    if (concept) week.concepts = [...(week.concepts ?? []), concept];
    if (post.factIds) week.factIds = [...(week.factIds ?? []), ...post.factIds];
    await writeFileAtomic(input.historyPath, `${JSON.stringify(history, null, 2)}\n`);
  }
  console.log(`3/4 Copy first: a new topic (${post.id}) for ${day} is waiting for the owner to keep or drop it. No picture was bought.`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      brand: { type: 'string' },
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
      'copy-first': { type: 'boolean', default: false },
      page: { type: 'boolean', default: false },
      topic: { type: 'string' },
      replace: { type: 'string' },
      'replace-post': { type: 'string' },
      'draw-kept': { type: 'string' },
      'draw-week': { type: 'string' },
      'draw-posts': { type: 'string' },
      'redraw-missing': { type: 'boolean', default: false },
      'redraw-post': { type: 'string' },
      'add-network': { type: 'string' },
      network: { type: 'string' },
      'redraw-network': { type: 'string' },
      networks: { type: 'string' },
      'review-budget': { type: 'string', default: '0.015' },
      'allow-paid-ai': { type: 'boolean', default: false },
      'require-logo': { type: 'boolean', default: false },
      'month-cap-usd': { type: 'string' },
      target: { type: 'string', default: 'scheduler' },
      publisher: { type: 'string', default: '../../publisher' },
    },
  });
  if (!values.site) throw new Error('Usage: --site <website> --channel <instagram username> [--days 7] [--dry-run]');
  const route = values.route;
  if (route !== 'ai' && route !== 'template') throw new Error('--route must be "ai" (the model draws the whole poster) or "template" (our own layout with an AI picture)');
  const networks = values.networks ? values.networks.split(',').map((n) => n.trim()).filter((n) => n !== '') : [];
  for (const n of networks) if (!isNetwork(n)) throw new Error(`--networks names ${NETWORKS.join(', ')}; "${n}" is not one of them`);
  if (networks.length > 0 && route !== 'ai') throw new Error('--networks belongs to the fully AI route');
  const target = values.target;
  const reviewBudget = Number(values['review-budget']);
  if (!Number.isFinite(reviewBudget) || reviewBudget <= 0) throw new Error('--review-budget must be a positive number of dollars');
  if (values.review && !values.art) throw new Error('--review looks at art-directed posters, so it needs --art');
  if (values.review && values['dry-run'] && !values['allow-paid-ai']) throw new Error('--review makes a vision request per poster: with --dry-run it needs --allow-paid-ai');
  if (target !== 'scheduler' && target !== 'publisher') throw new Error('--target must be "scheduler" or "publisher"');
  if (route === 'template' && target === 'scheduler' && !values.channel && !values['dry-run']) {
    throw new Error('--channel is required for --target scheduler unless --dry-run is set');
  }
  // The template route schedules or exports for real unless it is a dry run: refused up front (the AI route never does either; its posters wait for approval), before any paid work, unless publishing is switched on for this server.
  if (route === 'template' && !values['dry-run']) assertPublishingEnabled(target === 'publisher' ? 'exporting to the publisher' : 'scheduling');
  const weekdays = values.weekdays ? parseWeekdays(values.weekdays.split(',')) : undefined;
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('--days must be a whole number from 1 to 31');

  // A new topic for a dropped post of a written batch: one post for the same day, written from the website's facts like the rest of the batch and added to it.
  if (values.replace !== undefined && (!values['copy-first'] || values['replace-post'] === undefined || values.topic !== undefined || values.page)) throw new Error('--replace writes one new post for a dropped one: it needs --copy-first and --replace-post, and it is not a topic or a page read');
  // A topic the customer wrote herself: one post from her own statement only (the website's facts are not mixed in), written for the owner to confirm before any picture.
  if (values.topic !== undefined && (!values['copy-first'] || days !== 1 || values.page)) throw new Error('--topic writes one post for the owner to confirm: it needs --copy-first and --days 1, and it is not read from a page');
  // One page, not the whole site: only the address given is read. It is for a website that has no saved profile yet; one that has is already read, and its facts are used.
  if (values.page) {
    if (await pageModeBlocked(join(BRANDS_ROOT, values.brand ?? slugFromSite(values.site)))) throw new PageModeError('this website already has a saved profile with its facts, so it is not read again from a single page');
    process.env['CRAWL_ONLY_THIS_PAGE'] = 'true';
  }

  const envPath = envFilePath(values.env, process.env);
  loadEnvIfPresent(envPath);
  const ai = aiConfigFromEnv(process.env);
  if (values['image-model']) ai.pollinationsImageModel = values['image-model'];
  console.log(`AI: ${ai.primary === 'openai' ? `OpenAI (${ai.textModel} for text, ${ai.imageModel} at ${ai.imageQuality} quality for pictures)` : 'Pollinations'}${ai.fallback ? ', with the other provider as backup' : ''}`);

  const slug = values.brand ?? slugFromSite(values.site);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error('--brand must be lowercase letters, digits and dashes');
  // Every OpenAI call of this run is reserved against the budget caps before it is sent and recorded after (paid-ledger.ts). The file is shared by
  // all brands, so the daily caps hold across them; a run that hits a cap stops buying and keeps what it already made.
  const budgetLimits = budgetLimitsFromEnv(process.env);
  // The client's own monthly limit (set in the dashboard) replaces the default one; a value that is not a positive number stops the run before anything is bought.
  if (values['month-cap-usd'] !== undefined) {
    const monthCap = Number(values['month-cap-usd']);
    if (!Number.isFinite(monthCap) || monthCap <= 0) throw new Error('--month-cap-usd must be a positive number of dollars');
    budgetLimits.perBrandMonthUsd = monthCap;
  }
  // A product's customers also have a limit of pictures per channel per week; our own clients keep the dollar caps only.
  if (new ProductBrands(BRANDS_ROOT).has(slug)) budgetLimits.maxPicturesPerChannelWeek = weeklyLimitFromEnv(process.env);
  ai.ledger = new PaidLedger(resolve(process.env['PAID_LEDGER_FILE'] || join(BRANDS_ROOT, '..', 'ledger', 'paid-calls.jsonl')), budgetLimits, { jobId: `${slug}-${Date.now()}`, tenantId: 'owner', brandId: slug });
  let brandDir = join(BRANDS_ROOT, slug);
  // Another network for a batch already written (and perhaps drawn): the same topics, text only, no website read and no picture bought here.
  if (values['add-network']) {
    const asked = values.network;
    if (asked === undefined || !isNetwork(asked)) throw new Error(`--network names ${NETWORKS.join(', ')}`);
    console.log(`3/4 Writing a caption for ${asked} for the topics of ${values['add-network']}…`);
    ai.usage.purpose = 'writing';
    const result = await addNetworkToBatch({ brandDir, brand: slug, planFile: values['add-network'], network: asked as Network, facts: (await loadFacts(brandDir))?.facts ?? [], write: (posts, networks) => writeNetworkCaptions({ ai, posts, networks }) });
    console.log(ai.usage.format());
    console.log(`ADD_NETWORK_RESULT ${JSON.stringify(result)}`);
    return;
  }
  // Art direction is checked before anything paid happens, so a refusal costs nothing.
  let artSettings: ArtTenantSettings | undefined;
  if (values.art && route === 'template') {
    artSettings = await loadArtSettings(brandDir);
    assertArtAllowed({ settings: artSettings, env: process.env, dryRun: values['dry-run'], allowPaidAi: values['allow-paid-ai'] });
  }
  if (values['refresh-brand'] || !(await fileExists(join(brandDir, 'brand.json')))) {
    console.log(`1/4 Reading ${values.site} and building the brand profile…`);
    ai.usage.purpose = 'profile';
    brandDir = (await analyzeSite(values.site, BRANDS_ROOT, ai, { brand: slug })).dir;
  } else {
    console.log(`1/4 Using saved brand profile ${join('brands', slug, 'brand.json')}`);
  }
  // A website link is all a run needs: the facts the site states and its icon are gathered here when the brand lacks them (one crawl, no picture is bought).
  await ensureSiteAssets({ brandDir, site: values.site, ai, log: (m) => console.log(`    ${m}`) });
  const brand = parseBrand(await readJson(join(brandDir, 'brand.json')), 'brand.json');
  // How the posters will be branded is settled here, before anything is bought: a client that requires the website's real logo is stopped when it cannot be had.
  let branding: BrandingDecision | undefined;
  if (route === 'ai' && !values['plan-only']) {
    const brandingInput = { brand, brandDir, requireAuthenticLogo: values['require-logo'], compositorReady: COMPOSITOR_READY };
    const decided = resolveBranding(brandingInput);
    assertMayDraw(decided);
    branding = freezeLogo(brandDir, decided, logoPathFor(brandingInput, decided));
    console.log(`    Branding: ${branding.intendedMode} intended, ${branding.appliedMode} applied${branding.reason ? ` (${branding.reason})` : ''}`);
  }
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
    if (!values['draw-kept']) console.log(`2/4 Writing ${days} new pain-point posts${pattern} from ${startDate} (${planFile})…`);
    const loaded = await loadFacts(brandDir);
    // What the customer said herself is used only for the topic it was written for: a normal run never writes from it.
    const usableFact = (f: { status: string }): boolean => f.status === 'usable';
    const topicFacts = loaded && values.topic !== undefined ? factsForTopic(loaded.facts, values.topic).filter(usableFact) : [];
    if (values.topic !== undefined && topicFacts.length === 0) throw new Error(`TOPIC_NOT_FOUND: there is no statement ${values.topic} to write from`);
    const reviewed = loaded ? (values.topic !== undefined ? { facts: topicFacts, mode: 'all_usable' as const, approved: 0, rejected: 0 } : applyReview(loaded.facts.filter((f) => usableFact(f) && !isCustomerFact(f)), await loadReview(brandDir))) : undefined;
    if (loaded && reviewed) console.log(`    Evidence facts: ${loaded.facts.filter((f) => f.status === 'usable').length} usable of ${loaded.facts.length} (built ${loaded.file.builtAt.slice(0, 10)}); ${reviewed.mode === 'approved_only' ? `${reviewed.approved} approved by the owner are used` : 'none approved yet, all usable are eligible'}.`);
    else console.log('    No evidence facts for this brand: writing from the profile\'s proof points (legacy evidence coverage).');
    // Before anything is written or bought for this run: the site must be supported, the profile must be about it, and there must be a fact to write from.
    if (loaded) {
      const sample = loaded.file.snapshots.map((snap) => snap.text).join('\n').slice(0, 6000);
      const declared = loaded.facts.map((f) => f.language).find((l) => l !== '');
      const findings = [
        checkLanguage(sample, declared),
        checkBrandIdentity({ name: brand.name, site: brand.website || values.site, pageText: sample, titles: loaded.file.snapshots.map((snap) => snap.title) }),
        // A topic is one post from the customer's own statement: the site's own count of facts does not apply to it.
        ...(values.topic === undefined ? [checkEvidence(reviewed?.facts.length ?? 0)] : []),
      ].flatMap((f) => (f ? [f] : []));
      const stop = findings.find((f) => f.severity === 'stop');
      if (stop) throw new PreflightError(stop);
      for (const warning of findings) console.log(`    WARNING ${warning.code}: ${warning.reason}`);
      // A business that could not be confirmed gets no purchased picture; the poster still renders with the verified name and its own text.
      if (findings.some((f) => f.code === 'BRAND_UNVERIFIED')) ai.ledger?.disablePictures();
    }
    // Draws the given posts with the picture model and queues what is accepted for the owner's poster review. Nothing is scheduled or published.
    const drawPosters = async (finalPlan: WeekPlan, planFile: string, onlyNetwork?: Network): Promise<{ queued: number; stoppedBy?: string; outcomes: Map<string, { status: string; reason?: string }> }> => {
      if (values['dry-run'] && !values['allow-paid-ai']) throw new Error('fully AI posters make paid picture and vision calls: with --dry-run they need --allow-paid-ai');
      // The creative director is off unless it is switched on (CREATIVE_DIRECTOR_ENABLED=true): until it has had a live evaluation, each poster is drawn on its own.
      const directorEnabled = process.env['CREATIVE_DIRECTOR_ENABLED'] === 'true';
      if (placeholderEnabled(process.env)) console.log('    PLACEHOLDER PICTURES: no picture model is called; these are plain stand-ins for local testing, never for a real customer.');
      console.log(`3/4 Drawing the posters with the picture model (no template; creative director ${directorEnabled ? 'ON' : 'off'})…`);
      const factText = (id: string): string | undefined => { const fact = loaded?.facts.find((f) => f.id === id); return fact ? displayFact(fact) : undefined; };
      ai.usage.purpose = 'writing';
      // Every network gets a picture of its own (square for Instagram, Facebook and Google, wide for LinkedIn), each its own run with its own composition and ledger id;
      // the editorial check of the headlines is made once (in the first run), and a post it dropped is not drawn again for another network.
      // No picture is bought for a network the customer has no account for (when the product API has told us which are connected).
      const connected = readConnected(brandDir);
      const groups = pictureGroups(finalPlan.posts).filter((g) => (onlyNetwork === undefined || g.networks.includes(onlyNetwork)) && (connected === null || g.networks.length === 0 || g.networks.every((n) => connected.has(n))));
      // One picture per post per network: the brand's monthly picture limit is checked for the whole draw before the first one is bought.
      ai.ledger?.assertPicturesFit(groups.reduce((sum, g) => sum + g.postIds.length, 0));
      // The same draw, channel by channel, against the week's limit for a product's customer: refused whole, naming the channel that has no room.
      ai.ledger?.assertChannelPicturesFit(Object.fromEntries(groups.flatMap((g) => (g.networks[0] ? [[g.networks[0], g.postIds.length]] : []))));
      const dropped = new Set<string>();
      const outcomes = new Map<string, { status: string; reason?: string }>();
      let first = true;
      let queuedTotal = 0;
      let stoppedReason: string | undefined;
      const usageIds: string[] = [];
      // The real logo, frozen with the decision, goes on every poster that passes the checks. Not in placeholder mode: a placeholder card has no calm corner for it.
      const drawLogo = logoForDraw(process.env, branding?.status === 'applied' && branding.logoFile && branding.logoKind && branding.logoAssetSha256 ? { path: join(brandDir, branding.logoFile), kind: branding.logoKind, sha256: branding.logoAssetSha256 } : undefined);
      type Drawn = { group: (typeof groups)[number]; posts: PlannedPost[]; made: Awaited<ReturnType<typeof makeCreatives>>; outDir: string; suffix: string; network: Network | undefined };
      const drawnGroups: Drawn[] = [];
      const makeFor = (posts: PlannedPost[], outDir: string, group: (typeof groups)[number], network: Network | undefined, over: { startNote?: string; headlineGate?: boolean } = {}): ReturnType<typeof makeCreatives> => makeCreatives({
        ai, brand, brandSlug: slug, brandDir, posts, outDir, log: (m) => console.log(`    ${m}`), directorEnabled, shape: group.shape, ...(network ? { network } : {}), ...(over.startNote ? { startNote: over.startNote } : {}),
        // Local testing with no picture model (PICTURE_MODE=placeholder and LOCAL_PLACEHOLDER_PICTURES=yes): placeholder pictures, everything after them the normal pipeline.
        ...(placeholderEnabled(process.env) ? { deps: placeholderDeps({ ai }) } : first || over.startNote ? (over.startNote ? { deps: { headlineGate: { enabled: false, config: headlineGateFromEnv(process.env).config } } } : {}) : { deps: { headlineGate: { enabled: false, config: headlineGateFromEnv(process.env).config } } }),
        // The real logo, frozen with the decision, goes on every poster that passes the checks, in a corner the picture was asked to leave calm.
        ...(drawLogo ? { logo: drawLogo } : {}),
        factOf: (post) => (post.factIds ?? []).map(factText).filter((t): t is string => t !== undefined).join(' ') || post.anchor || post.painPoint,
      });
      for (const group of groups) {
        const posts = finalPlan.posts.filter((p) => group.postIds.includes(p.id) && !dropped.has(p.id));
        if (posts.length === 0) continue;
        const network = group.networks[0];
        const suffix = network ? `-${network}` : '';
        // A new picture for one network goes in a folder of its own, so the files of the pictures already made are never overwritten.
        const outDir = join(OUT_ROOT, slug, `${planFile.replace(/\.json$/, '')}-ai${suffix}${onlyNetwork ? `-redraw-${Date.now().toString(36)}` : ''}`);
        if (network) console.log(`    Drawing the ${group.shape.shape} picture for ${network}…`);
        const made = await makeFor(posts, outDir, group, network);
        first = false;
        for (const r of made.results) {
          if (r.status === 'dropped') dropped.add(r.postId);
          // A topic has a picture if any of its networks was accepted; otherwise the first reason it has none is kept.
          if (r.status === 'accepted' || !outcomes.has(r.postId)) outcomes.set(r.postId, { status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
        }
        const counts = made.results.reduce<Record<string, number>>((sum, r) => ({ ...sum, [r.status]: (sum[r.status] ?? 0) + 1 }), {});
        console.log(`    Posters: ${made.results.filter((r) => r.status === 'accepted').length} accepted of ${posts.length} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}). Report: ${join(outDir, 'creative-report.json')}`);
        if (made.stoppedBy) console.log(`    STOPPED: ${made.stoppedBy}`);
        usageIds.push(...posts.map((p) => `${slug}-${p.id}${suffix}`));
        drawnGroups.push({ group, posts, made, outDir, suffix, network });
        if (made.stoppedBy) { stoppedReason = String(made.stoppedBy); break; }
      }
      // The pictures of one topic for different networks are compared side by side: two that are clearly the same scene are drawn once more (the later network), told to
      // choose a different one. The second try counts as a picture of that channel; when it is not accepted, or a limit stops it, the first picture stays.
      if (!onlyNetwork && !stoppedReason && !placeholderEnabled(process.env) && process.env['LOOKALIKE_CHECK'] !== 'off' && drawnGroups.filter((d) => d.network).length >= 2) {
        const pictures = drawnGroups.flatMap((d) => (d.network ? d.made.results.flatMap((r) => (r.status === 'accepted' && r.file ? [{ postId: r.postId, network: d.network as Network, file: r.file }] : [])) : []));
        const replaced = await redrawAlike({
          pictures,
          lookAlikes: (posters) => batchLookAlikes(ai, posters),
          log: (m) => console.log(`    ${m}`),
          redraw: async (flagged, note) => {
            const target = drawnGroups.find((d) => d.network === flagged.network);
            const post = target?.posts.find((p) => p.id === flagged.postId);
            if (!target || !post) return null;
            const again = await makeFor([post], `${target.outDir}-again`, target.group, target.network, { startNote: note });
            const result = again.results.find((r) => r.postId === flagged.postId);
            if (!result || result.status !== 'accepted' || !result.file) return null;
            const index = target.made.results.findIndex((r) => r.postId === flagged.postId);
            if (index >= 0) target.made.results[index] = result;
            return { file: result.file };
          },
        });
        if (replaced.length > 0) console.log(`    ${replaced.length} picture${replaced.length === 1 ? '' : 's'} drawn again because it looked like another network's.`);
      }
      for (const { group, posts, made, outDir, network } of drawnGroups) {
        const queued = registerForReview({ brandDir, brandSlug: slug, planFile, report: made, posts, brand, facts: loaded?.facts ?? [], reportFile: join(outDir, 'creative-report.json'), ...(onlyNetwork ? { networks: [onlyNetwork] } : group.networks.length > 0 ? { networks: group.networks } : {}), ...(branding ? { branding } : {}) });
        queuedTotal += queued.length;
        void network;
      }
      console.log(ai.usage.format());
      const log = process.env['USAGE_LOG_FILE'];
      if (log) await appendUsageLog(log, ai.usage.records(slug, usageIds));
      console.log(`    ${queuedTotal} poster version${queuedTotal === 1 ? '' : 's'} added to the owner's review queue.`);
      console.log('4/4 Nothing was scheduled or published: every poster waits for the owner to approve it.');
      return { queued: queuedTotal, ...(stoppedReason ? { stoppedBy: stoppedReason } : {}), outcomes };
    };
    if (values['draw-kept']) {
      const keptFile = values['draw-kept'];
      if (route !== 'ai') throw new Error('--draw-kept belongs to the fully AI route');
      if (values['dry-run'] && !values['allow-paid-ai']) throw new Error('fully AI posters make paid picture and vision calls: with --dry-run they need --allow-paid-ai');
      const copy = new CopyStage(brandDir, slug);
      const stored = parseWeekPlan(await readJson(join(brandDir, keptFile)), keptFile);
      // A product's customer is drawn for only after the poster service was told which networks she has connected; nothing is bought for a network with no account.
      connectedForDraw(brandDir, new ProductBrands(BRANDS_ROOT).has(slug));
      const drawWeek = values['draw-week'];
      if (drawWeek !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(drawWeek)) throw new Error('--draw-week must be the Monday of the week, like 2026-11-16');
      const { postIds, changed } = copy.toDraw(keptFile, stored.posts.map((p) => ({ postId: p.id, headline: p.headline, caption: composeCaption(p), ...(variantTexts(p) ? { captions: variantTexts(p) as Record<string, string> } : {}) })), drawWeek);
      // A draw of a set of posts (the rest of their week stays open): only those, and each is made final on its own.
      const onlyPosts = values['draw-posts'] === undefined ? undefined : new Set(values['draw-posts'].split(',').map((id) => id.trim()).filter((id) => id !== ''));
      if (onlyPosts) {
        postIds.splice(0, postIds.length, ...postIds.filter((id) => onlyPosts.has(id)));
        changed.splice(0, changed.length, ...changed.filter((id) => onlyPosts.has(id)));
      }
      for (const id of changed) console.log(`    ${id}: its words changed after the owner kept it, so it is not drawn.`);
      // The facts are looked at again now: a plan is written at once and drawn weeks later, so a price or an offer can have gone stale, or a fact can have been taken out.
      let outdatedAny = false;
      const factsNow = await loadFacts(brandDir, { maxAgeDays: DRAW_FACT_MAX_AGE_DAYS });
      if (factsNow && !values['redraw-post']) {
        const outdated = postsWithOutdatedFacts(stored.posts.filter((p) => postIds.includes(p.id)), drawableFactIds(factsNow.facts, await loadReview(brandDir)));
        if (outdated.length > 0) {
          outdatedAny = true;
          for (const id of outdated) console.log(`    ${id}: a fact it is built on is out of date or was taken out, so it is not drawn.`);
          copy.setNotDrawn(keptFile, Object.fromEntries(outdated.map((id) => [id, { code: 'FACT_OUT_OF_DATE' as const, reason: NOT_DRAWN_REASON.FACT_OUT_OF_DATE }])));
          postIds.splice(0, postIds.length, ...postIds.filter((id) => !outdated.includes(id)));
        }
      }
      if (postIds.length === 0 && outdatedAny) throw new NothingDrawnError('every kept post rests on a fact that is out of date or was taken out, so nothing was drawn');
      if (postIds.length === 0) throw new Error(`${keptFile} has no kept posts to draw: keep at least one in the dashboard first`);
      if (values['redraw-post']) {
        // One more picture for one post (and one network of it) that already has pictures: only that network's picture is replaced, and every other network of the post keeps the one it has.
        const redrawPost = values['redraw-post'];
        const asked = values['redraw-network'];
        if (asked !== undefined && !isNetwork(asked)) throw new Error(`--redraw-network names ${NETWORKS.join(', ')}; "${asked}" is not one of them`);
        const redrawNetwork = asked as Network | undefined;
        if (!postIds.includes(redrawPost)) throw new Error(`${redrawPost} is not a kept post of ${keptFile}, so it is not drawn`);
        const versionsOfLine = (): number => new ReviewStore(brandDir, slug).list().filter((i) => i.version.planFile === keptFile && i.version.postId === redrawPost && (redrawNetwork === undefined || i.version.network === redrawNetwork)).length;
        const before = versionsOfLine();
        console.log(`3/4 Drawing one more picture for ${redrawPost}${redrawNetwork ? ` (${redrawNetwork})` : ''}…`);
        const redrawn = await drawPosters({ ...stored, renderMode: 'ai_v1', posts: stored.posts.filter((p) => p.id === redrawPost) }, keptFile, redrawNetwork);
        if (versionsOfLine() <= before) throw new NothingDrawnError(redrawn.stoppedBy ? `it stopped before a picture was accepted: ${redrawn.stoppedBy}` : 'no picture passed the checks, so there is nothing new to review');
        return;
      }
      let drawIds = postIds;
      if (values['redraw-missing']) {
        // A run that stopped part-way: only the kept posts that have no picture yet are drawn, so nothing already bought is bought again. The batch was closed by the first run.
        const made = new Set(new ReviewStore(brandDir, slug).list().filter((i) => i.version.planFile === keptFile).map((i) => i.version.postId));
        drawIds = postIds.filter((id) => !made.has(id));
        for (const id of postIds.filter((id) => made.has(id))) console.log(`    ${id}: already has its pictures, so it is not drawn again.`);
        if (drawIds.length === 0) throw new Error(`every kept post of ${keptFile} already has its pictures: nothing is left to draw`);
      } else {
        // The batch (or the week of it) is closed before anything is bought, so a crash part-way can never make a second run buy the same pictures again.
        if (onlyPosts) copy.markPostsDrawn(keptFile, drawIds);
        else if (drawWeek !== undefined) copy.markWeekDrawn(keptFile, drawWeek);
        else copy.markDrawn(keptFile);
      }
      console.log(`3/4 Drawing ${drawIds.length} kept post${drawIds.length === 1 ? '' : 's'} of ${keptFile}…`);
      const drawn = await drawPosters({ ...stored, renderMode: 'ai_v1', posts: stored.posts.filter((p) => drawIds.includes(p.id)) }, keptFile);
      // Which kept topics have a picture now and which have none and why, so the ones without stay open for the customer (and a retry draws only them).
      const haveNow = new Set(new ReviewStore(brandDir, slug).list().filter((i) => i.version.planFile === keptFile).map((i) => i.version.postId));
      copy.setNotDrawn(keptFile, Object.fromEntries(drawIds.filter((id) => !haveNow.has(id)).map((id) => [id, classifyNotDrawn(drawn.outcomes.get(id) ?? { status: 'failed' })])), drawIds.filter((id) => haveNow.has(id)));
      // A draw that left nothing for the owner to review is a failed draw, not a finished one: it is told as such, and what is missing can be asked for again.
      if (drawn.queued === 0) throw new NothingDrawnError(drawn.stoppedBy ? `it stopped before any picture was accepted: ${drawn.stoppedBy}` : 'no picture passed the checks, so there is nothing to review');
      // Some posts drawn and some not (a limit reached part-way, or a post the checks refused): the pictures made wait for review, and what is missing can be asked for again.
      const haveVersions = new Set(new ReviewStore(brandDir, slug).list().filter((i) => i.version.planFile === keptFile).map((i) => i.version.postId));
      const missing = drawIds.filter((id) => !haveVersions.has(id));
      if (missing.length > 0) throw new PartialDrawError(`${missing.length} of ${drawIds.length} kept post${drawIds.length === 1 ? '' : 's'} got no picture (${drawn.stoppedBy ?? 'the checks refused every try'}); the rest are waiting for review`);
      return;
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
    const writePlan = (schedule: PlanSchedule, over: Partial<Parameters<typeof planWeek>[0]> = {}): ReturnType<typeof planWeek> => planWeek({
      ai,
      compositionHints: process.env['IMAGE_COMPOSITION_HINT'] === '1',
      brand,
      brandSlug: slug,
      weekNumber,
      log: (m) => console.log(`    ${m}`),
      schedule,
      usedPainPoints: history.weeks.flatMap((w) => w.painPoints),
      recentPillars: history.weeks.flatMap((w) => w.pillars ?? []),
      recentHooks: history.weeks.flatMap((w) => w.hooks ?? []),
      recentHeadlines: history.weeks.flatMap((w) => w.headlines ?? []),
      recentConcepts: history.weeks.flatMap((w) => w.concepts ?? []),
      ...(verdicts ? { copyJudge: { judge: modelJudge(ai), cache: verdicts } } : {}),
      // The fully AI route writes more candidates than posts and reviews each with structured verdicts before any picture is bought.
      ...(route === 'ai' && reviewed ? { candidates: { review: modelReviewDeps(ai, ordinaryChecks(brand.name)) } } : {}),
      ...(reviewed ? { evidence: { facts: reviewed.facts, recentFactIds: history.weeks.flatMap((w) => w.factIds ?? []), ...(worthScores ? { worth: Object.fromEntries(Object.entries(worthScores).map(([id, sc]) => [id, effectiveTotal(sc)])) } : {}) } } : {}),
      ...over,
    });
    const schedule: PlanSchedule = { startDate, time: values.time, utcOffset: values['utc-offset'], count: days, ...(weekdays ? { weekdays } : {}) };
    if (values.replace !== undefined) {
      await replaceDroppedPost({ brandDir, slug, planFile: values.replace, droppedId: values['replace-post'] as string, networks, time: values.time, utcOffset: values['utc-offset'], history, historyPath, loaded, writePlan, ai });
      return;
    }
    let plan = await writePlan(schedule);
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
    // The days that were asked for are remembered, and a plan that came out short is topped up (copy-first plans only): empty days are filled from the drafts that passed
    // review but were not chosen, then by writing the day once more; a day nobody could write stays empty and is told.
    const requestedDays = scheduleDates(schedule).map((d) => d.slice(0, 10));
    if (values['copy-first'] && plan.posts.length > 0 && plan.posts.length < requestedDays.length) {
      const topped = await topUpPlan({
        posts: plan.posts,
        requestedDays,
        reserve: plan.reserveDrafts ?? [],
        dateOf: (day) => `${day}T${values.time}:00${values['utc-offset']}`,
        idOf: (i) => `w${String(weekNumber).padStart(2, '0')}-d${i + 1}`,
        log: (m) => console.log(`    ${m}`),
        writeDay: async (day, existing) => {
          const one = await writePlan({ startDate: day, time: values.time, utcOffset: values['utc-offset'], count: 1, weekdays: [weekdayOf(day)] }, {
            // A different request from the first one on purpose (the paid-call guard refuses an identical one): the day, and the ideas the plan already has.
            requestNote: `Write ONE post, for ${day}. It must be about a different fact and a different idea from the posts this plan already has: ${existing.slice(0, 20).map((p) => `"${p.headline.replaceAll('|', '')}"`).join('; ')}. ${CAPTION_RULES}`,
            recentHeadlines: [...history.weeks.flatMap((w) => w.headlines ?? []), ...existing.map((p) => p.headline)],
            recentConcepts: [...history.weeks.flatMap((w) => w.concepts ?? []), ...existing.flatMap((p) => { const r = conceptRecordOf(p); return r ? [r] : []; })],
          });
          return one.posts[0] ?? null;
        },
      });
      plan = { ...plan, posts: topped.posts };
      console.log(`    Topped up: ${topped.fromReserve.length} day${topped.fromReserve.length === 1 ? '' : 's'} from the reserve, ${topped.written.length} written once more, ${topped.stillEmpty.length} still empty.`);
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
    if (networks.length > 0 && finalPlan.posts.length > 0) {
      console.log(`    Writing a caption for each of ${networks.join(', ')}…`);
      ai.usage.purpose = 'writing';
      const factOf = (id: string): string | undefined => { const fact = loaded?.facts.find((f) => f.id === id); return fact ? displayFact(fact) : undefined; };
      const written = await writeNetworkCaptions({ ai, networks: networks as Network[], posts: finalPlan.posts.map((p) => ({ id: p.id, headline: p.headline.replaceAll('|', ''), caption: p.caption, hashtags: p.hashtags, facts: (p.factIds ?? []).map(factOf).filter((t): t is string => t !== undefined) })) });
      finalPlan = { ...finalPlan, posts: finalPlan.posts.map((p) => (written.variants[p.id] ? { ...p, variants: written.variants[p.id] as PostVariants } : p)) };
      console.log(`    Captions: ${written.report.written} of ${written.report.requested} written${written.report.retried ? `, ${written.report.retried} asked for again` : ''}${written.report.fallback.length ? `, ${written.report.fallback.length} use the main caption (${written.report.fallback.map((f) => `${f.postId}/${f.network}`).join(', ')})` : ''}.`);
    }
    await writeFileAtomic(join(brandDir, planFile), `${JSON.stringify(finalPlan, null, 2)}\n`);
    history.weeks.push({ file: planFile, createdAt: new Date().toISOString(), painPoints: plan.posts.map((p) => p.painPoint), pillars: plan.posts.map((p) => p.pillar ?? 'problem'), hooks: plan.posts.map((p) => p.hook ?? 'direct_statement'), headlines: plan.posts.map((p) => normalizeHeadline(p.headline)), concepts: plan.posts.flatMap((p) => conceptRecordOf(p) ?? []), ...(plan.posts.some((p) => p.factIds) ? { factIds: plan.posts.flatMap((p) => p.factIds ?? []) } : {}) });
    await writeFileAtomic(historyPath, `${JSON.stringify(history, null, 2)}\n`);

    if (route === 'ai' && values['copy-first'] && !values['plan-only']) {
      // The editorial gate reads each headline with its fact (one cheap request for the batch) and the owner is told which ones it would drop. It only advises here: the owner decides.
      const advice = new Map<string, string>();
      if (headlineGateFromEnv(process.env).enabled) {
        try {
          const factOf = (id: string): string | undefined => { const fact = loaded?.facts.find((f) => f.id === id); return fact ? displayFact(fact) : undefined; };
          const items = finalPlan.posts.map((p) => ({ id: p.id, headline: p.headline.replaceAll('|', ''), fact: (p.factIds ?? []).map(factOf).filter((t): t is string => t !== undefined).join(' ') || p.anchor || p.painPoint }));
          for (const verdict of judgeHeadlines(await scoreHeadlines(ai, items), headlineGateFromEnv(process.env).config)) if (!verdict.keep && verdict.reason) advice.set(verdict.id, verdict.reason);
        } catch (error) {
          console.log(`    The headline check could not run (${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}); no advice is shown.`);
        }
      }
      new CopyStage(brandDir, slug).open(planFile, finalPlan.posts.map((p) => ({ postId: p.id, date: p.date.slice(0, 10), headline: p.headline, caption: composeCaption(p), ...(p.variants ? { captions: Object.fromEntries(Object.entries(p.variants).map(([n, v]) => [n, { text: composeVariant(v), ...(v.fallback ? { fallback: true } : {}) }])) } : {}), ...(advice.has(p.id) ? { advice: advice.get(p.id) as string } : {}) })), requestedDays);
      console.log(`3/4 Copy first: ${finalPlan.posts.length} posts are waiting for the owner to keep or drop them. No picture was bought. Then: --draw-kept ${planFile}`);
      return;
    }
    if (route === 'ai' && !values['plan-only']) {
      await drawPosters(finalPlan, planFile);
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
    if (error instanceof PublishingDisabledError) console.error(`PUBLISHING_DISABLED: ${error.message}`);
    else if (error instanceof BudgetError && error.code === 'PICTURE_LIMIT_REACHED') console.error(`PICTURE_LIMIT_REACHED (${error.channel?.network ?? 'channel'}): ${error.message} Nothing was bought.`);
    else if (error instanceof BudgetError) console.error(`BUDGET_EXHAUSTED (${error.code}): ${error.message}. Nothing more was bought; what was already made is kept.`);
    else if (error instanceof PartialDrawError) console.error(`PARTIAL_DRAW: ${error.message}`);
    else if (error instanceof NothingDrawnError) console.error(`NOTHING_DRAWN: ${error.message}`);
    else if (error instanceof PageModeError) console.error(`PAGE_MODE_UNAVAILABLE: ${error.message}`);
    else if (error instanceof NothingWrittenError) console.error(`NOTHING_WRITTEN: ${error.message}`);
    else if (error instanceof CopyStageError) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof CrawlError) console.error(`${error.code}: ${error.message}`);
    else if (error instanceof ConnectedUnknownError) console.error(`CONNECTED_UNKNOWN: ${error.message}`);
    else if (error instanceof PreflightError) console.error(`${error.code}: ${error.message}. No posters were made.`);
    else console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
