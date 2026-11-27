/**
 * Runs the jobs the dashboard asked for (job-store.ts) by starting the engine (autopilot.ts) for each, one process per job, and keeps each job's progress up to date.
 *
 *   JOBS_ROOT=jobs node src/job-runner.ts        (run from the engine folder; it holds the picture key, the review service does not)
 *
 * A carousel job makes one carousel from the facts already read and queues it for review (carousel-cli.ts). A copy job reads the website and writes the posts, then stops before any picture is bought (--copy-first). A draw job draws only the kept posts of one batch
 * (--draw-kept). Neither schedules or publishes anything. Different brands run side by side (JOBS_CONCURRENCY, default 2); one brand runs one job at a time.
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { CopyStage } from './copy-stage.ts';
import { recordInterruptedDraw } from './interrupted-draw.ts';
import { JobStore, scrub, type Job, type NetworkResult } from './job-store.ts';
import { pictureRoomFor } from './picture-room.ts';
import { planEnded } from './plan-end.ts';
import { weeklyLimitFromEnv } from './picture-limit.ts';
import { ProductBrands } from './product-brands.ts';

export const COPY_TIMEOUT_MS = 30 * 60_000;
export const DRAW_TIMEOUT_MS = 45 * 60_000;
/** The line the engine prints when an add-a-network run is done: what it did for each topic. */
const RESULT_PREFIX = 'ADD_NETWORK_RESULT ';

/** The command line the engine is started with for a job. */
export function engineArgs(job: Job): string[] {
  if (job.kind === 'network') {
    if (!job.planFile || !job.network) throw new Error('a network job needs the batch and the network');
    return ['src/autopilot.ts', '--site', job.site, '--brand', job.brand, '--add-network', job.planFile, '--network', job.network];
  }
  if (job.kind === 'redraw' || job.kind === 'newnet') {
    if (!job.planFile || !job.postId) throw new Error('a redraw job needs the batch and the post to draw');
    return ['src/autopilot.ts', '--site', job.site, '--brand', job.brand, '--draw-kept', job.planFile, '--redraw-post', job.postId, ...(job.network ? ['--redraw-network', job.network] : [])];
  }
  if (job.kind === 'draw') {
    if (!job.planFile) throw new Error('a draw job needs the batch to draw');
    return ['src/autopilot.ts', '--site', job.site, '--brand', job.brand, '--draw-kept', job.planFile, ...(job.week ? ['--draw-week', job.week] : []), ...(job.postIds && job.postIds.length > 0 ? ['--draw-posts', job.postIds.join(',')] : []), ...(job.retry ? ['--redraw-missing'] : [])];
  }
  if (job.kind === 'replace') {
    if (!job.planFile || !job.postId) throw new Error('a replace job needs the batch and the dropped post');
    return ['src/autopilot.ts', '--site', job.site, '--brand', job.brand, '--copy-first', '--replace', job.planFile, '--replace-post', job.postId, ...(job.networks.length > 0 ? ['--networks', job.networks.join(',')] : [])];
  }
  if (job.kind === 'topic') {
    if (!job.topicId) throw new Error('a topic job needs the statement it is written from');
    return ['src/autopilot.ts', '--site', job.site, '--brand', job.brand, '--copy-first', '--topic', job.topicId, '--days', '1', ...(job.networks.length > 0 ? ['--networks', job.networks.join(',')] : []), ...(job.startDate ? ['--start', job.startDate] : []), ...(job.time ? ['--time', job.time] : [])];
  }
  if (job.kind === 'carouseldraw') {
    if (!job.carouselId) throw new Error('a carousel drawing job needs the carousel');
    return ['src/carousel-cli.ts', '--site', job.site, '--brand', job.brand, '--draw', job.carouselId];
  }
  if (job.kind === 'carousel') return ['src/carousel-cli.ts', '--site', job.site, '--brand', job.brand, '--networks', job.networks.join(','), ...(job.topicOnly ? ['--topic-only'] : []), ...(job.startDate ? ['--start', job.startDate] : []), ...(job.time ? ['--time', job.time] : [])];
  const networks = job.networks.length > 0 ? ['--networks', job.networks.join(',')] : [];
  const rhythm = job.weekdays && job.weekdays.length > 0 ? ['--weekdays', job.weekdays.join(',')] : [];
  return ['src/autopilot.ts', '--site', job.site, '--brand', job.brand, '--copy-first', ...(job.page ? ['--page'] : []), ...networks, ...(job.days ? ['--days', String(job.days)] : []), ...rhythm, ...(job.startDate ? ['--start', job.startDate] : []), ...(job.time ? ['--time', job.time] : [])];
}

/** What one line the engine printed says about the job. */
export function readLine(line: string, source: 'out' | 'err'): { step?: number; planFile?: string; weeks?: { done: number; total: number }; error?: { code: string; message: string } } {
  const weeks = /^WEEKS (\d{1,3})\/(\d{1,3})$/.exec(line);
  const step = /^(\d)\/4\s/.exec(line);
  const plan = /\((week-\d{2,4}\.json)\)/.exec(line) ?? /--draw-kept\s+(week-\d{2,4}\.json)/.exec(line);
  const error = source === 'err' ? /^([A-Z][A-Z_]+)(?: \([A-Za-z_]+\))?: (.+)$/.exec(line) : null;
  return {
    ...(step ? { step: Number(step[1]) } : {}),
    ...(weeks ? { weeks: { done: Number(weeks[1]), total: Number(weeks[2]) } } : {}),
    ...(plan ? { planFile: plan[1] as string } : {}),
    ...(error ? { error: { code: error[1] as string, message: scrub(error[2] as string) } } : {}),
  };
}

export type Exec = (args: string[], onLine: (line: string, source: 'out' | 'err') => void, timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean }>;

/** Starts the engine as a child of this process, in the engine folder, with this process's environment. */
export const execEngine = (cwd: string): Exec => (args, onLine, timeoutMs) =>
  new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);
    createInterface({ input: child.stdout }).on('line', (l) => onLine(l, 'out'));
    createInterface({ input: child.stderr }).on('line', (l) => onLine(l, 'err'));
    child.on('error', (error) => {
      onLine(`SPAWN_FAILED: ${error.message}`, 'err');
      clearTimeout(timer);
      done({ code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, timedOut });
    });
  });

/** Runs one claimed job to its end and records the result. */
/** What a runner knows beyond the job: how many more pictures a channel may have this week (null: no limit, a client of ours). */
export interface RunHooks {
  room?: (brand: string, network: string) => number | null;
  /** Called when a job that wrote a batch has ended in any way (also after a crash or a timeout), so the batch stops being "still being written". */
  finished?: (job: Job) => void;
}

export async function runJob(store: JobStore, job: Job, exec: Exec, hooks: RunHooks = {}): Promise<Job> {
  const ended = await runJobInner(store, job, exec, hooks);
  if (job.kind === 'copy') {
    try {
      hooks.finished?.(ended);
    } catch (error) {
      console.error(`could not close the written batch of job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return ended;
}

async function runJobInner(store: JobStore, job: Job, exec: Exec, hooks: RunHooks): Promise<Job> {
  const tail: string[] = [];
  let step: number | undefined;
  let planFileMade: string | undefined = job.kind !== 'copy' ? job.planFile : undefined;
  let weeks: { done: number; total: number } | undefined;
  let lastError: { code: string; message: string } | undefined;
  let networkResult: NetworkResult | undefined;
  let pending: NodeJS.Timeout | undefined;
  const flush = (): void => {
    pending = undefined;
    store.update(job.id, { logTail: tail, ...(step !== undefined ? { step } : {}), ...(planFileMade ? { planFileMade } : {}), ...(weeks ? { weeksDone: weeks.done, weeksTotal: weeks.total } : {}) });
  };
  const onLine = (line: string, source: 'out' | 'err'): void => {
    if (line.trim() === '') return;
    if (source === 'out' && line.startsWith(RESULT_PREFIX)) {
      try {
        const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as NetworkResult;
        if (typeof parsed.network === 'string' && Array.isArray(parsed.topics)) networkResult = parsed;
      } catch {
        // A line that is not the result is just output.
      }
      return;
    }
    tail.push(line);
    if (tail.length > 60) tail.shift();
    const read = readLine(line, source);
    if (read.step !== undefined) step = read.step;
    if (read.weeks) weeks = read.weeks;
    if (read.planFile && (job.kind === 'copy' || job.kind === 'carousel' || job.kind === 'carouseldraw' || job.kind === 'topic' || job.kind === 'replace')) planFileMade = read.planFile;
    if (read.error) lastError = read.error;
    // Progress is written at most once a second, however fast the engine talks.
    pending ??= setTimeout(flush, 1000);
  };
  const { code, timedOut } = await exec(engineArgs(job), onLine, job.kind === 'copy' || job.kind === 'topic' || job.kind === 'replace' ? COPY_TIMEOUT_MS : DRAW_TIMEOUT_MS);
  if (pending) clearTimeout(pending);
  const base = { logTail: tail, ...(step !== undefined ? { step } : {}), ...(planFileMade ? { planFileMade } : {}), ...(weeks ? { weeksDone: weeks.done, weeksTotal: weeks.total } : {}), ...(code !== null ? { exitCode: code } : {}) };
  if (code === 0 && !timedOut) {
    if (!networkResult) return store.update(job.id, { ...base, state: 'succeeded' });
    // A topic that has no picture of the new network's shape gets its own draw, one picture, queued now so the product can follow it.
    // Only as many as the channel has room for this week, soonest first (the topics are in plan order); the rest are drawn later by the weekly catch-up as room comes.
    let room = hooks.room?.(job.brand, networkResult.network) ?? Number.POSITIVE_INFINITY;
    const topics = networkResult.topics.map((topic) => {
      const { needsDraw, ...rest } = topic;
      if (!needsDraw || !job.planFile) return rest;
      if (room <= 0) return rest;
      room -= 1;
      const queued = store.enqueue({ kind: 'newnet', brand: job.brand, site: job.site, by: job.by, planFile: job.planFile, postId: topic.postId, network: networkResult?.network ?? '' });
      return { ...rest, drawJobId: queued.job.id };
    });
    return store.update(job.id, { ...base, state: 'succeeded', result: { network: networkResult.network, topics } });
  }
  const error = timedOut ? { code: 'TIMEOUT', message: 'the engine took too long and was stopped' } : lastError ?? { code: 'FAILED', message: `the engine stopped with exit code ${code ?? 'none'}` };
  return store.update(job.id, { ...base, state: 'failed', error });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts every job that may start now and returns once those have all finished. */
export async function drain(store: JobStore, exec: Exec, max: number, pid = process.pid): Promise<number> {
  store.recover((p) => p !== pid && alive(p));
  const running: Array<Promise<unknown>> = [];
  for (let job = store.claim(max, pid); job; job = store.claim(max, pid)) running.push(runJob(store, job, exec));
  await Promise.all(running);
  return running.length;
}

if (import.meta.main) {
  const store = new JobStore(resolve(process.env['JOBS_ROOT'] ?? 'jobs'));
  const max = Math.max(1, Number(process.env['JOBS_CONCURRENCY'] ?? 2) || 2);
  const exec = execEngine(resolve('.'));
  const active = new Set<Promise<unknown>>();
  const brandsRoot = resolve(process.env['BRANDS_ROOT'] ?? 'brands');
  const owners = new ProductBrands(brandsRoot);
  // The paid period of a customer has ended: nothing new is started for her, and a job that was waiting is closed unstarted (nothing is bought).
  store.spendGuard = (brand) => planEnded(join(brandsRoot, brand), Date.now());
  const roomHook = (brand: string, network: string): number | null => (owners.has(brand) ? pictureRoomFor({ ledgerFile: resolve(process.env['PAID_LEDGER_FILE'] || join(brandsRoot, '..', 'ledger', 'paid-calls.jsonl')), brand, network, limit: weeklyLimitFromEnv(process.env), now: new Date() }) : null);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => (stopping = true));
  console.log(`job runner started: up to ${max} at a time, jobs in ${join(resolve(process.env['JOBS_ROOT'] ?? 'jobs'))}`);
  const closeBatch = (ended: Job): void => {
    if (ended.planFileMade) new CopyStage(join(brandsRoot, ended.brand), ended.brand).finishWriting(ended.planFileMade);
  };
  for (const lost of store.recover((p) => p !== process.pid && alive(p))) {
    try {
      if (lost.kind === 'copy') closeBatch(lost);
      if (lost.kind === 'draw') {
        const reopened = recordInterruptedDraw(brandsRoot, lost);
        if (reopened.length > 0) console.error(`the draw of ${lost.brand} stopped early: ${reopened.length} topic(s) have no picture and are open to draw again`);
      }
    } catch (error) {
      console.error(`could not close the written batch or reopen the topics of job ${lost.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  while (!stopping) {
    for (let job = store.claim(max, process.pid); job; job = store.claim(max, process.pid)) {
      if (store.spendGuard?.(job.brand)) {
        store.update(job.id, { state: 'failed', error: { code: 'PLAN_ENDED', message: 'the plan has ended, so this was not started' } });
        continue;
      }
      const work = runJob(store, job, exec, { room: roomHook, finished: closeBatch }).finally(() => active.delete(work));
      active.add(work);
    }
    await new Promise((wake) => setTimeout(wake, 3000));
  }
  await Promise.all(active);
}
