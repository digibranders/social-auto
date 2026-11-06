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
  exec: (args: string[]) => Promise<{ code: number; tail: string }>;
  /** Hands the brand's approved posters to the publisher. */
  release: (brandDir: string) => Promise<number>;
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
      try {
        outcome = await deps.exec(autopilotArgsFor(plan, site, { index: batch.index, dates: batch.dates }, { requireAuthenticLogo: client.requireAuthenticLogo === true }));
      } catch (error) {
        outcome = { code: 1, tail: error instanceof Error ? error.message : String(error) };
      }
      // The run writes the next week-NN.json; remember which one is this plan's, so its posters keep this plan's platforms.
      const written = (await weekFiles(join(brandsRoot, siteBrand))).filter((f) => !before.includes(f));
      if (written.length === 1) batch.weekFile = written[0] as string;
      else if (outcome.code === 0) { batch.note = 'could not tell which plan file this run wrote, so its posters are not tied to this plan\'s platforms'; log(`${client.brand}: ${batch.note}`); }
      batch.status = outcome.code === 0 ? 'done' : 'failed';
      batch.finishedAt = stamp(deps);
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
    for (const f of files) {
      const file = join(brandsRoot, siteBrand, 'campaigns', f);
      const state = await readState(file);
      if (!state || !state.batches.some((b) => b.status === 'done')) continue;
      if (!deps.publishingEnabled()) {
        if (state.releaseNote !== 'publishing is switched off, so nothing was released') { state.releaseNote = 'publishing is switched off, so nothing was released'; await writeState(file, state); }
        continue;
      }
      try {
        const posts = await deps.release(join(brandsRoot, siteBrand));
        if (state.released?.posts !== posts) {
          state.released = { at: stamp(deps), posts };
          delete state.releaseNote;
          state.updatedAt = stamp(deps);
          await writeState(file, state);
          log(`${state.brand}: ${posts} approved post${posts === 1 ? '' : 's'} are with the publisher`);
        }
        released.push(state);
      } catch (error) {
        state.releaseNote = `release failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
        await writeState(file, state);
        log(`${state.brand}: ${state.releaseNote}`);
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
    exec: (args) => new Promise((done) => {
      let out = '';
      const child = execFile(process.execPath, args, { cwd: resolve('.'), timeout: 60 * 60 * 1000, maxBuffer: 16 << 20, env: process.env }, () => undefined);
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
      child.on('close', (code) => done({ code: code ?? 1, tail: out.slice(-4000) }));
      child.on('error', (error) => done({ code: 1, tail: error.message }));
    }),
    release: async (brandDir) => (await exportToPublisher(brandDir, publisherDir)).length,
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
