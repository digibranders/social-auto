/**
 * Website in, scheduled Instagram posts out.
 *
 *   node src/autopilot.ts --site example.com --channel their_insta [--days 7] [--time 10:00]
 *                         [--weekdays mon,wed,fri] [--start YYYY-MM-DD] [--utc-offset +05:30] [--image-model zimage]
 *                         [--refresh-brand] [--dry-run] [--target scheduler|publisher]
 *                         [--art] [--allow-paid-ai]
 *
 * First run for a site builds brands/<slug>/brand.json from the website. Every run writes the
 * next week-NN.json with new pain points (history.json prevents repeats) and renders the posters.
 * Unless --dry-run, posts then go to the target: "scheduler" queues them in the local scheduler
 * app (needs --channel); "publisher" exports them to the Vercel publisher folder.
 *
 * --art adds art direction (a separate model call per plan, measured rendering, review before scheduling). It only runs
 * when the brand's art.json enables it, is switched off by ART_DIRECTION_DISABLED=1, and needs --allow-paid-ai with --dry-run.
 * Art-directed posters wait for `node src/art-review.ts ... --approve` before they are scheduled or exported.
 */
import { loadFacts } from './evidence-pipeline.ts';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { aiConfigFromEnv } from './ai.ts';
import { appendUsageLog } from './usage.ts';
import { analyzeSite, slugFromSite } from './analyze.ts';
import { parseWeekdays } from './cadence.ts';
import { parseBrand, parseWeekPlan, readJson, type WeekPlan } from './content.ts';
import { acquireTenantLock, artDirectPlan, assertArtAllowed, loadArtSettings, readArtHistory, writeFileAtomic, type ArtHistoryEntry, type ArtTenantSettings } from './art-pipeline.ts';
import { recordRenderedArt } from './art-review.ts';
import { exportToPublisher } from './export-publisher.ts';
import { envFilePath, loadEnvIfPresent } from './platform.ts';
import { normalizeHeadline } from './hooks.ts';
import type { ConceptRecord } from './concepts.ts';
import { conceptRecordOf, planWeek } from './planner.ts';
import { renderPlan } from './render.ts';
import { DEFAULT_SCHEDULER_URL, schedulePlan } from './schedule.ts';

const BRANDS_ROOT = resolve('brands');
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
      'allow-paid-ai': { type: 'boolean', default: false },
      target: { type: 'string', default: 'scheduler' },
      publisher: { type: 'string', default: '../../publisher' },
    },
  });
  if (!values.site) throw new Error('Usage: --site <website> --channel <instagram username> [--days 7] [--dry-run]');
  const target = values.target;
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
  let brandDir = join(BRANDS_ROOT, slug);
  // Art direction is checked before anything paid happens, so a refusal costs nothing.
  let artSettings: ArtTenantSettings | undefined;
  if (values.art) {
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
    if (loaded) console.log(`    Evidence facts: ${loaded.facts.filter((f) => f.status === 'usable').length} usable of ${loaded.facts.length} (built ${loaded.file.builtAt.slice(0, 10)}).`);
    else console.log('    No evidence facts for this brand: writing from the profile\'s proof points (legacy evidence coverage).');
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
      ...(loaded ? { evidence: { facts: loaded.facts, recentFactIds: history.weeks.flatMap((w) => w.factIds ?? []) } } : {}),
    });
    console.log(`    Evidence coverage: ${plan.evidenceCoverage ?? 'legacy'}.`);
    if (plan.insufficientConcepts) {
      const { requested, produced, reasons } = plan.insufficientConcepts;
      console.log(`    Only ${produced} of ${requested} posts: the rest were left out (a repeated idea, or copy the claim gate would not allow).\n    ${reasons.join('\n    ')}`);
    }
    let finalPlan: WeekPlan = plan;
    if (artSettings) {
      console.log('2b/4 Art direction (one batched model call)…');
      const directed = await artDirectPlan({ ai, plan, brand, history: readArtHistory(history), settings: artSettings });
      finalPlan = directed.plan;
      const { counts, flags, requests, status } = directed.report;
      console.log(`    ${status}: ${counts.directed} directed, ${counts.repaired} repaired, ${counts.fallback} fell back, ${counts.failed} without art direction (${requests} request${requests === 1 ? '' : 's'}).`);
      for (const flag of flags) console.log(`    FLAG: ${flag}`);
      await writeFileAtomic(join(brandDir, `art-report-${planFile}`), `${JSON.stringify(directed.report, null, 2)}\n`);
    }
    await writeFileAtomic(join(brandDir, planFile), `${JSON.stringify(finalPlan, null, 2)}\n`);
    history.weeks.push({ file: planFile, createdAt: new Date().toISOString(), painPoints: plan.posts.map((p) => p.painPoint), pillars: plan.posts.map((p) => p.pillar ?? 'problem'), hooks: plan.posts.map((p) => p.hook ?? 'direct_statement'), headlines: plan.posts.map((p) => normalizeHeadline(p.headline)), concepts: plan.posts.flatMap((p) => conceptRecordOf(p) ?? []), ...(plan.posts.some((p) => p.factIds) ? { factIds: plan.posts.flatMap((p) => p.factIds ?? []) } : {}) });
    await writeFileAtomic(historyPath, `${JSON.stringify(history, null, 2)}\n`);

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
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
