/**
 * The work the dashboard asks the engine to do (read a website and write the posts; draw the kept posts), as small files the owner can follow.
 *
 * The review service only writes a request here; a separate runner (job-runner.ts, which alone holds the picture key) picks it up. One file per job,
 * jobs/<id>.json, changed only under one lock. The same request made twice returns the job that already exists instead of starting a second one:
 *   - copy: one active job per website (a new one can start once the last has finished);
 *   - carousel: one active job per client (a new one can start once the last has finished);
 *   - replace: one active job per dropped post (a new topic written for its day); a new one can start once the last has finished;
 *   - topic: one active job per client (a post written from the customer's own statement; a new one can start once the last has finished);
 *   - draw: one job per written batch (or, for a draw of a set of posts, one active job per set), so a repeated click can never buy the pictures twice; once it has failed, one more may draw only what it did not finish.
 * At most one job per brand runs at a time (two would fight over the same week files); different brands run side by side.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { LockError, syncDir, withFileLock } from './file-lock.ts';

export type JobKind = 'copy' | 'draw' | 'carousel' | 'carouseldraw' | 'redraw' | 'network' | 'newnet' | 'topic' | 'replace';
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed';

export class JobError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID' | 'LOCKED' | 'PLAN_ENDED';
  constructor(code: JobError['code'], message: string) {
    super(message);
    this.name = 'JobError';
    this.code = code;
  }
}

export interface JobSpec {
  kind: JobKind;
  brand: string;
  /** The website the brand was read from (needed by both kinds: the engine is started with it). */
  site: string;
  by: string;
  /** Networks to write for (copy and carousel). */
  networks?: string[];
  /** How many posts to write (copy only). */
  days?: number;
  /** The address is one page, not a whole website: only that page is read (copy only). */
  page?: boolean;
  /** The weekdays the posts fall on, e.g. ["mon","thu"] (copy only); without it the engine writes consecutive days. */
  weekdays?: string[];
  /** The day of the first post, YYYY-MM-DD (copy), or the day the carousel is for (carousel); without it the engine chooses the next free day. */
  startDate?: string;
  /** The time of day the posts go out, HH:MM India time (copy and carousel); 10:00 when not given. */
  time?: string;
  /** The written batch to draw (draw only). */
  planFile?: string;
  /** Draw again only what a failed draw did not finish (draw only; allowed once the last draw of the batch has failed). */
  retry?: boolean;
  /** The one post, and the one network of it, to draw a new picture for (redraw only; the batch was already drawn). */
  postId?: string;
  network?: string;
  /** The week of the batch to draw, as its Monday YYYY-MM-DD (draw only). A batch of one piece has none. */
  week?: string;
  /** Set when the system asked for it (the weekly draw), not a person. Such a draw is not counted against what a customer may ask for. */
  auto?: boolean;
  /** The customer's own statement a post is written from (topic only): its words are kept beside the brand (customer-facts.ts), never in the job. */
  topicId?: string;
  /** A draw of these posts of a written batch only (the rest of their week stays open). Without it a draw covers every kept post of the week, as batches drawn before this did. */
  postIds?: string[];
  /** A carousel job that writes only the topic, the slide headlines and the channel words (no picture); the drawing is a job of its own once the customer kept it (carousel only). */
  topicOnly?: boolean;
  /** The carousel to draw (carouseldraw only). */
  carouselId?: string;
}

/** What an add-a-network job found, per topic of the batch. */
export interface NetworkResult {
  network: string;
  topics: Array<{ postId: string; outcome: 'written'; /** The caption is the main one adapted to the network, because a fresh one could not be written within the checks; `reasonCode` says why, as a fixed code. */ fallback?: true; reasonCode?: 'WORDS_REFUSED' | 'TOO_LONG' | 'NO_FACTS' | 'NO_CAPTION'; /** Versions made from a picture the topic already had (same bytes, cost 0). */ versionIds?: string[]; /** The id of the draw queued for this network's own picture. */ drawJobId?: string; /** Set by the engine: this topic needs its own picture drawn; the runner queues the draw and replaces this with `drawJobId`. */ needsDraw?: true }>;
}

export interface Job extends Omit<JobSpec, 'networks' | 'days' | 'weekdays' | 'page' | 'retry'> {
  id: string;
  key: string;
  state: JobState;
  networks: string[];
  days?: number;
  weekdays?: string[];
  page?: true;
  retry?: true;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Where the engine is, 1 to 4 (read the site, write, draw, queued for review). */
  step?: number;
  /** The plan file the engine wrote or is drawing, once it is known. */
  planFileMade?: string;
  /** For a batch written week by week: how many weeks are saved so far and how many there will be. */
  weeksDone?: number;
  weeksTotal?: number;
  runnerPid?: number;
  exitCode?: number;
  error?: { code: string; message: string };
  /** What an add-a-network job did for each topic (that kind only). */
  result?: NetworkResult;
  /** The last lines the engine printed, secrets removed. */
  logTail: string[];
}

export const JOB_ID = /^job-[a-z0-9]{6,12}-[a-f0-9]{8}$/;
const LOG_LINES = 30;
const LOG_LINE_CHARS = 300;

/** A key that looks like one of ours must never be shown, whatever the engine printed. */
export const scrub = (line: string): string => line.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, '[key removed]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, 'Bearer [removed]').slice(0, LOG_LINE_CHARS);

export const keyOf = (spec: Pick<JobSpec, 'kind' | 'brand' | 'planFile' | 'postId' | 'network' | 'week' | 'postIds' | 'carouselId'>): string =>
  spec.kind === 'carouseldraw' ? `carouseldraw:${spec.brand}:${spec.carouselId ?? ''}` : spec.kind === 'draw' ? `draw:${spec.brand}:${spec.planFile ?? ''}${spec.week ? `:${spec.week}` : ''}${spec.postIds && spec.postIds.length > 0 ? `:${createHash('sha1').update([...spec.postIds].sort().join(',')).digest('hex').slice(0, 10)}` : ''}` : spec.kind === 'network' ? `network:${spec.brand}:${spec.planFile ?? ''}:${spec.network ?? ''}` : spec.kind === 'newnet' ? `newnet:${spec.brand}:${spec.planFile ?? ''}:${spec.postId ?? ''}:${spec.network ?? ''}` : spec.kind === 'carousel' ? `carousel:${spec.brand}` : spec.kind === 'topic' ? `topic:${spec.brand}` : spec.kind === 'replace' ? `replace:${spec.brand}:${spec.planFile ?? ''}:${spec.postId ?? ''}` : spec.kind === 'redraw' ? `redraw:${spec.brand}:${spec.planFile ?? ''}:${spec.postId ?? ''}:${spec.network ?? ''}` : `copy:${spec.brand}`;

export class JobStore {
  /** Says whether nothing new may be made for a brand (its customer's paid period has ended); set by whoever owns the brands folder. */
  spendGuard?: (brand: string) => boolean;
  private readonly dir: string;
  private readonly now: () => Date;
  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.now = now;
  }

  private fileOf(id: string): string {
    if (!JOB_ID.test(id)) throw new JobError('INVALID', 'that is not a job id');
    return join(this.dir, `${id}.json`);
  }

  private readAll(): Job[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => n.startsWith('job-') && n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(join(this.dir, n), 'utf8')) as Job)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private write(job: Job): void {
    const file = this.fileOf(job.id);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, { flag: 'w' });
    renameSync(temp, file);
    syncDir(this.dir);
  }

  private locked<T>(work: () => T): T {
    mkdirSync(this.dir, { recursive: true });
    try {
      return withFileLock(join(this.dir, '.lock'), work, { timeoutMs: 5000 });
    } catch (error) {
      if (error instanceof LockError) throw new JobError('LOCKED', 'the job list is busy, so nothing was changed');
      throw error;
    }
  }

  /** Adds a job, or returns the one that already stands for the same request. */
  enqueue(spec: JobSpec): { job: Job; created: boolean } {
    if (spec.by.trim() === '') throw new JobError('INVALID', 'who is asking must be given');
    if (this.spendGuard?.(spec.brand)) throw new JobError('PLAN_ENDED', 'the plan has ended, so nothing new is written or drawn for this customer');
    return this.locked(() => {
      const key = keyOf(spec);
      const existing = this.readAll().filter((j) => j.key === key);
      const last = existing.at(-1);
      // A draw is asked for once; only after it has failed may what it did not finish be asked for again (never while one is waiting, running or done).
      const retrying = spec.kind === 'draw' && spec.retry === true && last?.state === 'failed';
      // A draw of a set of posts is the same ask only while one for that very set is waiting or running: once it has finished, the posts it did not finish may be asked for again.
      const standing = retrying ? undefined : spec.kind === 'draw' && !spec.postIds ? last : existing.find((j) => j.state === 'queued' || j.state === 'running');
      if (standing) return { job: standing, created: false };
      // Jobs run in the order they were asked for: two asked in the same millisecond still get distinct, increasing times.
      const newest = this.readAll().reduce((latest, j) => Math.max(latest, Date.parse(j.createdAt)), 0);
      const stamp = new Date(Math.max(this.now().getTime(), newest + 1));
      const job: Job = {
        id: `job-${stamp.getTime().toString(36)}-${randomBytes(4).toString('hex')}`,
        key,
        kind: spec.kind,
        brand: spec.brand,
        site: spec.site,
        by: spec.by.trim().slice(0, 80),
        networks: spec.networks ?? [],
        ...(spec.days !== undefined ? { days: spec.days } : {}),
        ...(spec.page ? { page: true as const } : {}),
        ...(retrying ? { retry: true as const } : {}),
        ...(spec.weekdays && spec.weekdays.length > 0 ? { weekdays: spec.weekdays } : {}),
        ...(spec.startDate ? { startDate: spec.startDate } : {}),
        ...(spec.time ? { time: spec.time } : {}),
        ...(spec.planFile ? { planFile: spec.planFile } : {}),
        ...(spec.postId ? { postId: spec.postId } : {}),
        ...(spec.week ? { week: spec.week } : {}),
        ...(spec.auto ? { auto: true as const } : {}),
        ...(spec.topicId ? { topicId: spec.topicId } : {}),
        ...(spec.postIds && spec.postIds.length > 0 ? { postIds: [...spec.postIds] } : {}),
        ...(spec.network ? { network: spec.network } : {}),
        ...(spec.topicOnly ? { topicOnly: true as const } : {}),
        ...(spec.carouselId ? { carouselId: spec.carouselId } : {}),
        state: 'queued',
        createdAt: stamp.toISOString(),
        logTail: [],
      };
      this.write(job);
      return { job, created: true };
    });
  }

  get(id: string): Job {
    const file = this.fileOf(id);
    if (!existsSync(file)) throw new JobError('NOT_FOUND', 'no such job');
    return JSON.parse(readFileSync(file, 'utf8')) as Job;
  }

  list(filter: { brand?: string; state?: JobState } = {}): Job[] {
    return this.readAll()
      .filter((j) => (filter.brand === undefined || j.brand === filter.brand) && (filter.state === undefined || j.state === filter.state))
      .reverse();
  }

  /** Takes the oldest waiting job whose brand has nothing running, as long as fewer than `max` jobs run; null when there is nothing to start. */
  claim(max: number, pid: number): Job | null {
    return this.locked(() => {
      const all = this.readAll();
      const running = all.filter((j) => j.state === 'running');
      if (running.length >= max) return null;
      const busy = new Set(running.map((j) => j.brand));
      const next = all.find((j) => j.state === 'queued' && !busy.has(j.brand));
      if (!next) return null;
      const started: Job = { ...next, state: 'running', startedAt: this.now().toISOString(), runnerPid: pid };
      this.write(started);
      return started;
    });
  }

  /** Records progress or the end of a job. A finished job is never changed again. */
  update(id: string, patch: Partial<Pick<Job, 'state' | 'step' | 'planFileMade' | 'weeksDone' | 'weeksTotal' | 'exitCode' | 'error' | 'logTail' | 'result'>>): Job {
    return this.locked(() => {
      const job = this.get(id);
      if (job.state === 'succeeded' || job.state === 'failed') return job;
      const next: Job = { ...job, ...patch, ...(patch.logTail ? { logTail: patch.logTail.slice(-LOG_LINES).map(scrub) } : {}) };
      if (patch.state === 'succeeded' || patch.state === 'failed') next.finishedAt = this.now().toISOString();
      this.write(next);
      return next;
    });
  }

  /** Jobs left "running" by a runner that is gone (a restart, a crash) are marked failed, never silently retried: a draw may already have bought pictures. */
  recover(isAlive: (pid: number) => boolean): Job[] {
    return this.locked(() => {
      const lost = this.readAll().filter((j) => j.state === 'running' && !(j.runnerPid !== undefined && isAlive(j.runnerPid)));
      return lost.map((job) => {
        const failed: Job = { ...job, state: 'failed', finishedAt: this.now().toISOString(), error: { code: 'INTERRUPTED', message: 'the job runner stopped while this was running' } };
        this.write(failed);
        return failed;
      });
    });
  }
}
