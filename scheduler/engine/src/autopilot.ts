/**
 * Website in, scheduled Instagram posts out.
 *
 *   node src/autopilot.ts --site example.com --channel their_insta [--days 7] [--time 10:00]
 *                         [--start YYYY-MM-DD] [--utc-offset +05:30] [--image-model zimage]
 *                         [--refresh-brand] [--dry-run] [--target scheduler|publisher]
 *
 * First run for a site builds brands/<slug>/brand.json from the website. Every run writes the
 * next week-NN.json with new pain points (history.json prevents repeats) and renders the posters.
 * Unless --dry-run, posts then go to the target: "scheduler" queues them in the local scheduler
 * app (needs --channel); "publisher" exports them to the Vercel publisher folder.
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyzeSite, slugFromSite } from './analyze.ts';
import { parseBrand, parseWeekPlan, readJson } from './content.ts';
import { exportToPublisher } from './export-publisher.ts';
import { planWeek } from './planner.ts';
import { DEFAULT_IMAGE_MODEL, renderPlan } from './render.ts';
import { DEFAULT_SCHEDULER_URL, schedulePlan } from './schedule.ts';

const BRANDS_ROOT = resolve('brands');
const WEEK_FILE = /^week-(\d+)\.json$/;

interface History {
  weeks: Array<{ file: string; createdAt: string; painPoints: string[] }>;
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
  if (!value) throw new Error(`${name} is not set in ${envPath}`);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' },
      channel: { type: 'string' },
      days: { type: 'string', default: '7' },
      time: { type: 'string', default: '10:00' },
      start: { type: 'string' },
      'utc-offset': { type: 'string', default: '+05:30' },
      'image-model': { type: 'string', default: DEFAULT_IMAGE_MODEL },
      env: { type: 'string', default: '../upstream/.env' },
      'scheduler-url': { type: 'string', default: DEFAULT_SCHEDULER_URL },
      'refresh-brand': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
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
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 31) throw new Error('--days must be a whole number from 1 to 31');

  const envPath = resolve(values.env);
  process.loadEnvFile(envPath);
  const pollinationsKey = requireEnv('POLLINATIONS_API_KEY', values.env);

  const slug = slugFromSite(values.site);
  let brandDir = join(BRANDS_ROOT, slug);
  if (values['refresh-brand'] || !(await fileExists(join(brandDir, 'brand.json')))) {
    console.log(`1/4 Reading ${values.site} and building the brand profile…`);
    brandDir = (await analyzeSite(values.site, BRANDS_ROOT, pollinationsKey)).dir;
  } else {
    console.log(`1/4 Using saved brand profile ${join('brands', slug, 'brand.json')}`);
  }
  const brand = parseBrand(await readJson(join(brandDir, 'brand.json')), 'brand.json');

  const historyPath = join(brandDir, 'history.json');
  const history = await readHistory(historyPath);
  const weekNumber = await nextWeekNumber(brandDir);
  const planFile = `week-${String(weekNumber).padStart(2, '0')}.json`;
  const startDate =
    values.start ?? chooseStartDate(await lastPlannedDate(brandDir), tomorrowAt(values['utc-offset']));
  console.log(`2/4 Writing ${days} new pain-point posts from ${startDate} (${planFile})…`);
  const plan = await planWeek({
    apiKey: pollinationsKey,
    brand,
    brandSlug: slug,
    weekNumber,
    log: (m) => console.log(`    ${m}`),
    schedule: {
      startDate,
      time: values.time,
      utcOffset: values['utc-offset'],
      count: days,
    },
    usedPainPoints: history.weeks.flatMap((w) => w.painPoints),
  });
  await writeFile(join(brandDir, planFile), `${JSON.stringify(plan, null, 2)}\n`);
  history.weeks.push({ file: planFile, createdAt: new Date().toISOString(), painPoints: plan.posts.map((p) => p.painPoint) });
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);

  console.log('3/4 Rendering posters…');
  const outDir = await renderPlan({
    brandDir,
    planFile,
    pollinationsKey,
    imageModel: values['image-model'],
    log: (m) => console.log(`    ${m}`),
  });

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
    schedulerKey: requireEnv('SCHEDULER_API_KEY', values.env),
    schedulerUrl: values['scheduler-url'],
    log: (m) => console.log(`    ${m}`),
  });
  console.log(`Done: ${count} posts scheduled. Preview: ${join(outDir, 'preview.html')}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
