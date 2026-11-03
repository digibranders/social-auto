/**
 * Uploads rendered images to Scheduler and schedules each post of a week plan.
 * Already-scheduled posts are recorded in scheduled.json and skipped on re-runs.
 *
 *   node src/schedule.ts --brand brands/brandbasket --plan week-01.json --channel dai23_sy [--dry-run]
 */
import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { composeCaption, parseWeekPlan, readJson } from './content.ts';
import { envFilePath, loadEnvIfPresent } from './platform.ts';
import { SchedulerClient } from './scheduler-client.ts';

export const DEFAULT_SCHEDULER_URL = 'http://127.0.0.1:4007/api';
const INSTAGRAM_PROVIDERS = new Set(['instagram', 'instagram-standalone']);

type ScheduledLog = Record<string, { postId: string; date: string; scheduledAt: string }>;

async function readLog(path: string): Promise<ScheduledLog> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ScheduledLog;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export interface ScheduleOptions {
  brandDir: string;
  planFile: string;
  channel: string;
  schedulerKey: string;
  schedulerUrl?: string;
  dryRun?: boolean;
  log?: (message: string) => void;
}

/** Schedules each future, not-yet-scheduled post. Returns how many were scheduled. */
export async function schedulePlan(options: ScheduleOptions): Promise<number> {
  const log = options.log ?? console.log;
  const plan = parseWeekPlan(await readJson(join(options.brandDir, options.planFile)), options.planFile);
  const outDir = resolve('out', basename(options.brandDir), basename(options.planFile, '.json'));
  const logPath = join(outDir, 'scheduled.json');
  const scheduled = await readLog(logPath);

  const scheduler = new SchedulerClient(options.schedulerUrl ?? DEFAULT_SCHEDULER_URL, options.schedulerKey);
  const channel = (await scheduler.listIntegrations()).find(
    (i) => i.profile === options.channel && INSTAGRAM_PROVIDERS.has(i.identifier),
  );
  if (!channel) throw new Error(`No Instagram channel "${options.channel}" connected in Scheduler`);
  if (channel.disabled) throw new Error(`Channel "${options.channel}" is disabled in Scheduler`);

  let count = 0;
  const now = Date.now();
  for (const post of plan.posts) {
    const imagePath = join(outDir, `${post.id}.jpg`);
    if (scheduled[post.id]) {
      log(`${post.id}: already scheduled (${scheduled[post.id]?.postId}), skipping`);
      continue;
    }
    if (Date.parse(post.date) <= now) {
      log(`${post.id}: ${post.date} is in the past, skipping`);
      continue;
    }
    await access(imagePath);
    if (options.dryRun) {
      log(`${post.id}: would schedule for ${post.date} on ${channel.profile}`);
      continue;
    }
    const image = await scheduler.uploadImage(imagePath);
    const created = await scheduler.schedulePost({
      integrationId: channel.id,
      providerIdentifier: channel.identifier,
      date: post.date,
      caption: composeCaption(post),
      image,
    });
    scheduled[post.id] = { postId: created.postId, date: post.date, scheduledAt: new Date().toISOString() };
    await writeFile(logPath, `${JSON.stringify(scheduled, null, 2)}\n`);
    log(`${post.id}: scheduled for ${post.date} (post ${created.postId})`);
    count++;
  }
  return count;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      brand: { type: 'string' },
      plan: { type: 'string' },
      channel: { type: 'string' },
      env: { type: 'string' },
      'scheduler-url': { type: 'string', default: DEFAULT_SCHEDULER_URL },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  if (!values.brand || !values.plan || !values.channel) {
    throw new Error('Usage: --brand <dir> --plan <file.json> --channel <instagram username> [--dry-run]');
  }
  const envPath = envFilePath(values.env, process.env);
  loadEnvIfPresent(envPath);
  const key = process.env['SCHEDULER_API_KEY'];
  if (!key) throw new Error(`SCHEDULER_API_KEY is not set (looked in the environment and in ${envPath})`);
  await schedulePlan({
    brandDir: resolve(values.brand),
    planFile: values.plan,
    channel: values.channel,
    schedulerKey: key,
    schedulerUrl: values['scheduler-url'],
    dryRun: values['dry-run'],
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
