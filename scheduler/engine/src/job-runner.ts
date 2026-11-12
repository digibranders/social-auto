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
import { JobStore, scrub, type Job, type NetworkResult } from './job-store.ts';

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
    return ['src/autopilot.ts', '--site', job.site, '--brand', job.brand, '--draw-kept', job.planFile, ...(job.retry ? ['--redraw-missing'] : [])];
  }
  if (job.kind === 'carousel') return ['src/carousel-cli.ts', '--site', job.site, '--networks', job.networks.join(','), ...(job.startDate ? ['--start', job.startDate] : []), ...(job.time ? ['--time', job.time] : [])];
  const networks = job.networks.length > 0 ? ['--networks', job.networks.join(',')] : [];
  const rhythm = job.weekdays && job.weekdays.length > 0 ? ['--weekdays', job.weekdays.join(',')] : [];
  return ['src/autopilot.ts', '--site', job.site, '--brand', job.brand, '--copy-first', ...(job.page ? ['--page'] : []), ...networks, ...(job.days ? ['--days', String(job.days)] : []), ...rhythm, ...(job.startDate ? ['--start', job.startDate] : []), ...(job.time ? ['--time', job.time] : [])];
}

/** What one line the engine printed says about the job. */
export function readLine(line: string, source: 'out' | 'err'): { step?: number; planFile?: string; error?: { code: string; message: string } } {
  const step = /^(\d)\/4\s/.exec(line);
  const plan = /\((week-\d{2,4}\.json)\)/.exec(line) ?? /--draw-kept\s+(week-\d{2,4}\.json)/.exec(line);
  const error = source === 'err' ? /^([A-Z][A-Z_]+)(?: \([A-Za-z_]+\))?: (.+)$/.exec(line) : null;
  return {
    ...(step ? { step: Number(step[1]) } : {}),
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
export async function runJob(store: JobStore, job: Job, exec: Exec): Promise<Job> {
  const tail: string[] = [];
  let step: number | undefined;
  let planFileMade: string | undefined = job.kind !== 'copy' ? job.planFile : undefined;
  let lastError: { code: string; message: string } | undefined;
  let networkResult: NetworkResult | undefined;
  let pending: NodeJS.Timeout | undefined;
  const flush = (): void => {
    pending = undefined;
    store.update(job.id, { logTail: tail, ...(step !== undefined ? { step } : {}), ...(planFileMade ? { planFileMade } : {}) });
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
    if (read.planFile && (job.kind === 'copy' || job.kind === 'carousel')) planFileMade = read.planFile;
    if (read.error) lastError = read.error;
    // Progress is written at most once a second, however fast the engine talks.
    pending ??= setTimeout(flush, 1000);
  };
  const { code, timedOut } = await exec(engineArgs(job), onLine, job.kind === 'copy' ? COPY_TIMEOUT_MS : DRAW_TIMEOUT_MS);
  if (pending) clearTimeout(pending);
  const base = { logTail: tail, ...(step !== undefined ? { step } : {}), ...(planFileMade ? { planFileMade } : {}), ...(code !== null ? { exitCode: code } : {}) };
  if (code === 0 && !timedOut) {
    if (!networkResult) return store.update(job.id, { ...base, state: 'succeeded' });
    // A topic that has no picture of the new network's shape gets its own draw, one picture, queued now so the product can follow it.
    const topics = networkResult.topics.map((topic) => {
      const { needsDraw, ...rest } = topic;
      if (!needsDraw || !job.planFile) return rest;
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
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => (stopping = true));
  console.log(`job runner started: up to ${max} at a time, jobs in ${join(resolve(process.env['JOBS_ROOT'] ?? 'jobs'))}`);
  store.recover((p) => p !== process.pid && alive(p));
  while (!stopping) {
    for (let job = store.claim(max, process.pid); job; job = store.claim(max, process.pid)) {
      const work = runJob(store, job, exec).finally(() => active.delete(work));
      active.add(work);
    }
    await new Promise((wake) => setTimeout(wake, 3000));
  }
  await Promise.all(active);
}
