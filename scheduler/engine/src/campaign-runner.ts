/**
 * Turns a client's posting plan (set in the dashboard when the website was added) into posters waiting for approval, and releases the approved ones.
 * It is run on a timer, does a little each time, and is safe to run twice at once:
 *
 *   make     for each client with a plan, a run of the autopilot per batch of at most eight days, one batch at a time. The autopilot's AI route only fills
 *            the review queue: nothing is scheduled or posted by this step. Each batch is recorded before it starts and after it ends, and a batch that
 *            was running when the process died is NEVER started again by itself (it may have spent money): it is marked interrupted for a person to look at.
 *   release  for each campaign with something approved, hand the approved posters to the publisher with the days and platforms of the plan. Only when
 *            publishing is switched on (SOCIAL_PUBLISHING_ENABLED=true), and only exact approved versions (see export-publisher.ts). Posters whose day has
 *            already passed are left out by the export's own rules.
 *
 * State lives in brands/<site>/campaigns/<id>.json and which week file each batch wrote, so the export can give every poster the platforms of the plan it came from.
 */
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { slugFromSite } from './analyze.ts';
import { autopilotArgsFor, parsePostingPlan, planBatches, planId, todayAt, type PostingPlan } from './posting-plan.ts';
import { exportToPublisher } from './export-publisher.ts';

export type BatchStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
/** What a running batch is doing, as far as the autopilot's own progress lines say. */
export type BatchStage = 'reading' | 'writing' | 'drawing' | 'finishing';
export type CampaignStatus = 'queued' | 'running' | 'awaiting_approval' | 'partial' | 'failed' | 'interrupted';

export interface BatchState {
  index: number;
  dates: string[];
  status: BatchStatus;
  startedAt?: string;
  finishedAt?: string;
  /** The end of the run's output, for a person to read when it failed. */
  tail?: string;
  /** The plan file this batch wrote (week-NN.json), so the export knows which platforms its posters are for. */
  weekFile?: string;
  /** While it runs: the step it is on, the latest thing it said, and how many posters it has finished. Cleared when it ends. */
  stage?: BatchStage;
  detail?: string;
  drawn?: number;
  /** How many posters of this batch really reached the review queue (the autopilot says so when it ends). Missing in older records. */
  queued?: number;
  /** The step a failed run had reached when it stopped; missing when it stopped before the first step (a logo that is required and cannot be had, say). */
  stoppedAt?: BatchStage;
  note?: string;
}

export interface CampaignState {
  id: string;
  brand: string;
  /** The folder name of the site under brands/ (what the review queue calls the brand). */
  siteBrand: string;
  site: string;
  plan: PostingPlan;
  status: CampaignStatus;
  batches: BatchState[];
  createdAt: string;
  updatedAt: string;
  /** When approved posters were last handed to the publisher, and how many days were exported. */
  released?: { at: string; posts: number };
  releaseNote?: string;
}

/** A client as the dashboard keeps it (publisher/lib/clients.ts), reduced to what the runner needs. */
export interface PlannedClient {
  brand: string;
  website: string;
  /** One entry per plan; each has its own platforms, days and rhythm, and is made and released on its own. */
  plans: unknown[];
  /** The client's setting: every poster must carry the website's real logo. */
  requireAuthenticLogo?: boolean;
}

export interface RunnerDeps {
  /** Runs the autopilot with these arguments and resolves with its exit code and the end of its output. */
  exec: (args: string[], onLine?: (line: string) => void) => Promise<{ code: number; tail: string }>;
  /** Hands the brand's approved posters to the publisher. */
  release: (brandDir: string, options: { brand: string; weekFiles: string[] }) => Promise<number>;
  now?: () => Date;
  /** Whether publishing is switched on; release is skipped, and says so, when it is not. */
  publishingEnabled: () => boolean;
  log?: (message: string) => void;
}

/** The week plan files in a site's folder, which the autopilot adds one of per run. */
async function weekFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => /^week-\d+\.json$/.test(f));
  } catch {
    return [];
  }
}

/**
 * What one line of the autopilot's output says about progress: the step it is on ("1/4 Reading ...", "3/4 Drawing ..."), the latest thing it said
 * (the poster it is drawing, or the site page it is reading) and a poster finished ("w01-d1: accepted after 1 attempt"). Lines that say nothing about
 * progress give null. Nothing here is trusted beyond its length: it is shown to the owner as plain text.
 */
export function parseProgressLine(line: string): { stage?: BatchStage; detail?: string; drawn?: true; queued?: number } | null {
  const text = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
  if (text === '') return null;
  const step = /^([1-4])\/4\s+(.*)$/.exec(text);
  if (step) {
    const stage: BatchStage = step[1] === '1' ? 'reading' : step[1] === '2' ? 'writing' : step[1] === '3' ? 'drawing' : 'finishing';
    return { stage, detail: (step[2] as string).slice(0, 160) };
  }
  const added = /^(\d+) posters? added to the owner's review queue/.exec(text);
  if (added) return { queued: Number(added[1]) };
  if (/^\S+: accepted after \d+ attempt/.test(text)) return { detail: text.slice(0, 160), drawn: true };
  // The pipeline's own lines are indented in the autopilot's output; they say which poster is being drawn or why one was turned back.
  if (/^[\w.-]+: (attempt \d+|dropped|rejected)/.test(text)) return { detail: text.slice(0, 160) };
  return null;
}

const stamp = (deps: RunnerDeps): string => (deps.now?.() ?? new Date()).toISOString();
const stateFile = (brandsRoot: string, siteBrand: string, id: string): string => join(brandsRoot, siteBrand, 'campaigns', `${id}.json`);

async function readState(file: string): Promise<CampaignState | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CampaignState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeState(file: string, state: CampaignState): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temp, file);
}

/** The overall status of a campaign from its batches. */
export function statusOf(batches: readonly BatchState[]): CampaignStatus {
  if (batches.some((b) => b.status === 'interrupted')) return 'interrupted';
  if (batches.some((b) => b.status === 'running')) return 'running';
  if (batches.every((b) => b.status === 'pending')) return 'queued';
  if (batches.some((b) => b.status === 'pending')) return 'running';
  const failed = batches.filter((b) => b.status === 'failed').length;
  return failed === batches.length ? 'failed' : failed > 0 ? 'partial' : 'awaiting_approval';
}

/** Makes the posters of every client's plan that has not been made yet. */
export async function makeCampaigns(clients: readonly PlannedClient[], brandsRoot: string, deps: RunnerDeps): Promise<CampaignState[]> {
  const log = deps.log ?? (() => undefined);
  const touched: CampaignState[] = [];
  for (const client of clients) for (const rawPlan of client.plans) {
    let plan: PostingPlan;
    try {
      // A plan whose first day has passed while it waited is still a plan: its past days are simply not made.
      plan = parsePostingPlan(rawPlan, { now: new Date(0) });
    } catch (error) {
      log(`${client.brand}: the posting plan is not valid (${error instanceof Error ? error.message : String(error)}); skipped`);
      continue;
    }
    const site = client.website;
    const siteBrand = slugFromSite(site);
    const id = planId(site, plan);
    const file = stateFile(brandsRoot, siteBrand, id);
    const today = todayAt(plan.utcOffset, deps.now?.() ?? new Date());
    let state = await readState(file);
    if (!state) {
      const batches = planBatches(plan).map((b) => ({ index: b.index, dates: b.dates.filter((d) => d >= today) })).filter((b) => b.dates.length > 0);
      if (batches.length === 0) { log(`${client.brand}: every day of the plan has already passed; nothing to make`); continue; }
      state = { id, brand: client.brand, siteBrand, site, plan, status: 'queued', batches: batches.map((b) => ({ index: b.index, dates: b.dates, status: 'pending' as const })), createdAt: stamp(deps), updatedAt: stamp(deps) };
      await writeState(file, state);
    }
    // A batch left running by a process that is gone may have spent money: it is not repeated by itself.
    for (const b of state.batches) if (b.status === 'running') { b.status = 'interrupted'; b.finishedAt = stamp(deps); b.note = 'the runner stopped while this was running; check the paid-call ledger before running it again'; }
    state.status = statusOf(state.batches);
    await writeState(file, state);
    for (const batch of state.batches) {
      if (batch.status !== 'pending') continue;
      batch.status = 'running';
      batch.startedAt = stamp(deps);
      state.status = 'running';
      state.updatedAt = stamp(deps);
      await writeState(file, state);
      log(`${client.brand}: making ${batch.dates.length} poster${batch.dates.length === 1 ? '' : 's'} for ${batch.dates[0]}${batch.dates.length > 1 ? ` to ${batch.dates.at(-1)}` : ''}`);
      let outcome: { code: number; tail: string };
      const before = await weekFiles(join(brandsRoot, siteBrand));
      // What the run says as it goes is written to the record, so the dashboard can show what is being made. Writes are spaced out (and a change of step
      // is written at once), never one per line.
      let lastWrite = 0;
      let writing: Promise<void> = Promise.resolve();
      const onLine = (line: string): void => {
        const seen = parseProgressLine(line);
        if (!seen) return;
        const changed = seen.stage !== undefined && seen.stage !== batch.stage;
        if (seen.stage) batch.stage = seen.stage;
        if (seen.detail) batch.detail = seen.detail;
        if (seen.drawn) batch.drawn = (batch.drawn ?? 0) + 1;
        if (seen.queued !== undefined) batch.queued = seen.queued;
        const now = (deps.now?.() ?? new Date()).getTime();
        if (!changed && !seen.drawn && seen.queued === undefined && now - lastWrite < 1500) return;
        lastWrite = now;
        state.updatedAt = stamp(deps);
        writing = writing.then(() => writeState(file, state)).catch(() => undefined);
      };
      try {
        outcome = await deps.exec(autopilotArgsFor(plan, site, { index: batch.index, dates: batch.dates }, { requireAuthenticLogo: client.requireAuthenticLogo === true }), onLine);
        await writing;
      } catch (error) {
        await writing;
        outcome = { code: 1, tail: error instanceof Error ? error.message : String(error) };
      }
      // The run writes the next week-NN.json; remember which one is this plan's, so its posters keep this plan's platforms.
      const written = (await weekFiles(join(brandsRoot, siteBrand))).filter((f) => !before.includes(f));
      if (written.length === 1) batch.weekFile = written[0] as string;
      else if (outcome.code === 0) { batch.note = 'could not tell which plan file this run wrote, so its posters are not tied to this plan\'s platforms'; log(`${client.brand}: ${batch.note}`); }
      batch.status = outcome.code === 0 ? 'done' : 'failed';
      batch.finishedAt = stamp(deps);
      if (outcome.code !== 0 && batch.stage) batch.stoppedAt = batch.stage;
      delete batch.stage;
      delete batch.detail;
      batch.tail = outcome.tail.slice(-1500);
      log(outcome.code === 0 ? `${client.brand}: batch ${batch.index + 1} finished` : `${client.brand}: batch ${batch.index + 1} failed: ${outcome.tail.trim().split('\n').at(-1)?.slice(0, 300) ?? 'no output'}`);
      state.status = statusOf(state.batches);
      state.updatedAt = stamp(deps);
      await writeState(file, state);
      // A refusal to spend, or a site that cannot be read, would repeat for every later batch: stop this campaign here.
      if (outcome.code !== 0 && /BUDGET_EXHAUSTED|LOGO_REQUIRED|SITE_ACCESS_BLOCKED|URL_REFUSED|UNSUPPORTED_LANGUAGE|INSUFFICIENT_EVIDENCE|SITE_UNREACHABLE/.test(outcome.tail)) {
        for (const later of state.batches) if (later.status === 'pending') { later.status = 'failed'; later.note = 'not tried: the earlier run stopped for a reason that would repeat'; }
        state.status = statusOf(state.batches);
        await writeState(file, state);
        break;
      }
    }
    touched.push(state);
  }
  return touched;
}

/** One campaign as the dashboard may see it: what it is, where each batch is, and a short reason when one failed. Never the raw output. */
export interface CampaignSummary {
  id: string;
  /** The client the plan belongs to (the dashboard's name for it). */
  brand: string;
  site: string;
  plan: { platforms: string[]; startDate: string; durationDays: number; postsPerWeek?: number; time: string };
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
  /** What happens to approved posters: `off` when publishing is switched off (nothing is scheduled), `on` with how many posters were handed to the publisher at the last pass. Missing before the first pass. */
  release?: { state: 'off' } | { state: 'on'; posts: number };
  batches: Array<{ index: number; dates: string[]; status: BatchStatus; stage?: BatchStage; stoppedAt?: BatchStage; detail?: string; drawn?: number; queued?: number; startedAt?: string; finishedAt?: string; failure?: string; note?: string }>;
}

/** The last line of a failed run's output, cut short: enough to say why, with no room for anything long. */
const failureOf = (tail: string | undefined): string | undefined => {
  const line = (tail ?? '').trim().split('\n').filter((l) => l.trim() !== '').at(-1);
  return line ? line.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 240) : undefined;
};

/** Every campaign in every site folder under `brandsRoot`, the most recently changed first. An unreadable record is left out. */
export async function listCampaigns(brandsRoot: string): Promise<CampaignSummary[]> {
  let sites: string[];
  try {
    sites = (await readdir(brandsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: CampaignSummary[] = [];
  for (const site of sites) {
    let files: string[];
    try {
      files = (await readdir(join(brandsRoot, site, 'campaigns'))).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      const state = await readState(join(brandsRoot, site, 'campaigns', f)).catch(() => undefined);
      if (!state || !Array.isArray(state.batches) || typeof state.plan !== 'object' || state.plan === null) continue;
      out.push({
        id: state.id, brand: state.brand, site: state.site,
        plan: { platforms: state.plan.platforms, startDate: state.plan.startDate, durationDays: state.plan.durationDays, ...(state.plan.postsPerWeek ? { postsPerWeek: state.plan.postsPerWeek } : {}), time: state.plan.time },
        status: state.status, createdAt: state.createdAt, updatedAt: state.updatedAt,
        ...(state.released ? { release: { state: 'on' as const, posts: state.released.posts } } : state.releaseNote ? { release: { state: 'off' as const } } : {}),
        batches: state.batches.map((b) => ({
          index: b.index, dates: b.dates, status: b.status,
          ...(b.stage ? { stage: b.stage } : {}), ...(b.stoppedAt ? { stoppedAt: b.stoppedAt } : {}), ...(b.detail ? { detail: b.detail } : {}), ...(typeof b.drawn === 'number' ? { drawn: b.drawn } : {}), ...(typeof b.queued === 'number' ? { queued: b.queued } : {}),
          ...(b.startedAt ? { startedAt: b.startedAt } : {}), ...(b.finishedAt ? { finishedAt: b.finishedAt } : {}),
          ...(b.status === 'failed' || b.status === 'interrupted' ? { failure: failureOf(b.tail) ?? b.note } : {}),
          ...(b.note ? { note: b.note.slice(0, 240) } : {}),
        })),
      });
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Hands approved posters to the publisher for every campaign that has made some. Returns the campaigns that were released. */
export async function releaseCampaigns(brandsRoot: string, deps: RunnerDeps): Promise<CampaignState[]> {
  const log = deps.log ?? (() => undefined);
  const released: CampaignState[] = [];
  let siteBrands: string[] = [];
  try {
    siteBrands = (await readdir(brandsRoot, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return released;
  }
  for (const siteBrand of siteBrands) {
    let files: string[] = [];
    try {
      files = (await readdir(join(brandsRoot, siteBrand, 'campaigns'))).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    // A client's posters are released together, under the client's own name, from every week file its plans made: the schedule keeps one set of entries
    // for a client, so releasing one plan at a time would wipe what the others released.
    const groups = new Map<string, Array<{ file: string; state: CampaignState }>>();
    for (const f of files) {
      const file = join(brandsRoot, siteBrand, 'campaigns', f);
      const state = await readState(file);
      if (!state || !state.batches.some((b) => b.status === 'done')) continue;
      if (!deps.publishingEnabled()) {
        if (state.releaseNote !== 'publishing is switched off, so nothing was released') { state.releaseNote = 'publishing is switched off, so nothing was released'; await writeState(file, state); }
        continue;
      }
      groups.set(state.brand, [...(groups.get(state.brand) ?? []), { file, state }]);
    }
    for (const [client, members] of groups) {
      const weekFiles = [...new Set(members.flatMap(({ state }) => state.batches.flatMap((b) => (b.weekFile ? [b.weekFile] : []))))];
      try {
        const posts = await deps.release(join(brandsRoot, siteBrand), { brand: client, weekFiles });
        let changed = false;
        for (const { file, state } of members) {
          if (state.released?.posts !== posts || state.releaseNote) {
            changed = true;
            state.released = { at: stamp(deps), posts };
            delete state.releaseNote;
            state.updatedAt = stamp(deps);
            await writeState(file, state);
          }
          released.push(state);
        }
        if (changed) log(`${client}: ${posts} approved post${posts === 1 ? '' : 's'} are with the publisher`);
      } catch (error) {
        for (const { file, state } of members) {
          state.releaseNote = `release failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
          await writeState(file, state);
        }
        log(`${client}: release failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 320));
      }
    }
  }
  return released;
}

// ---- Running it

/** Whether a process with this id is alive on this machine. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The right to run, held for the whole run. A second runner started by the timer while one is working finds the lease held by a live process and
 * leaves at once; a lease left by a process that is gone is taken over. Returns a function that gives the lease back, or null when someone else holds it.
 */
export async function acquireLease(path: string): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: 'wx' });
      return async () => { try { await unlink(path); } catch { /* already gone */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = Number((await readFile(path, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return null;
      await unlink(path).catch(() => undefined);
    }
  }
  return null;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      clients: { type: 'string' },
      brands: { type: 'string', default: 'brands' },
      publisher: { type: 'string', default: '../../publisher' },
    },
  });
  if (!values.clients) throw new Error('Usage: node src/campaign-runner.ts --clients <clients.json> [--brands brands] [--publisher ../../publisher]');
  const brandsRoot = resolve(values.brands);
  const publisherDir = resolve(values.publisher);
  let clients: PlannedClient[] = [];
  try {
    const raw = JSON.parse(await readFile(resolve(values.clients), 'utf8')) as { clients?: Array<Record<string, unknown>> };
    clients = (raw.clients ?? []).flatMap((c) => (typeof c['brand'] === 'string' && typeof c['website'] === 'string' && (Array.isArray(c['plans']) ? c['plans'].length > 0 : c['plan'] !== undefined) ? [{ brand: c['brand'], website: c['website'], plans: Array.isArray(c['plans']) ? (c['plans'] as unknown[]) : [c['plan']], ...(c['requireAuthenticLogo'] === true ? { requireAuthenticLogo: true } : {}) }] : []));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const deps: RunnerDeps = {
    exec: (args, onLine) => new Promise((done) => {
      let out = '';
      let partial = '';
      // Whole lines only are passed on, as they arrive, so the record can follow the run.
      const feed = (chunk: string): void => {
        out += chunk;
        if (!onLine) return;
        partial += chunk;
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) onLine(line);
      };
      const child = execFile(process.execPath, args, { cwd: resolve('.'), timeout: 60 * 60 * 1000, maxBuffer: 16 << 20, env: process.env }, () => undefined);
      child.stdout?.on('data', (d: Buffer) => feed(d.toString()));
      child.stderr?.on('data', (d: Buffer) => feed(d.toString()));
      child.on('close', (code) => done({ code: code ?? 1, tail: out.slice(-4000) }));
      child.on('error', (error) => done({ code: 1, tail: error.message }));
    }),
    release: async (brandDir, options) => (await exportToPublisher(brandDir, publisherDir, Date.now(), options)).length,
    publishingEnabled: () => process.env['SOCIAL_PUBLISHING_ENABLED'] === 'true',
    log: (m) => console.log(m),
  };
  await mkdir(brandsRoot, { recursive: true });
  // One runner at a time: a second one started by the timer while this runs leaves at once instead of repeating work.
  const giveBack = await acquireLease(join(brandsRoot, '.campaigns.lease'));
  if (!giveBack) { console.log('another campaign runner is working; leaving it to finish'); return; }
  try {
    await makeCampaigns(clients, brandsRoot, deps);
    await releaseCampaigns(brandsRoot, deps);
  } finally {
    await giveBack();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
