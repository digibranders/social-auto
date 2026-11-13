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
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { slugFromSite } from './analyze.ts';
import { autopilotArgsFor, parsePostingPlan, planBatches, planId, todayAt, type PostingPlan , carouselArgsFor, planCarouselDates } from './posting-plan.ts';
import { exportToPublisher } from './export-publisher.ts';
import { ReviewError, ReviewStore } from './review-store.ts';
import { checkLeadTime, type LeadTimeNotice } from './lead-time.ts';
import { ntfySender } from './owner-notice.ts';
import { ProductBrands } from './product-brands.ts';

/** The lock one release pass holds while it writes the publisher's schedule, in the brands folder beside the campaign runner's own lease. */
export const RELEASE_LOCK = '.release.lock';
/** How long a pass waits for another release to finish: a release is a matter of seconds. */
const RELEASE_WAIT_MS = 2 * 60_000;

export type BatchStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
/** What a running batch is doing, as far as the autopilot's own progress lines say. */
export type BatchStage = 'reading' | 'writing' | 'drawing' | 'finishing';
export type CampaignStatus = 'queued' | 'running' | 'awaiting_approval' | 'partial' | 'failed' | 'interrupted';

export interface BatchState {
  index: number;
  dates: string[];
  /** A carousel batch is one carousel for its one day, made by carousel-cli.ts; a batch without a kind is single posters made by the autopilot. */
  kind?: 'carousel';
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
  /** Who approves the client's posters: a person (`manual`, the default) or the system after its automatic checks (`auto`). */
  approvalMode?: 'manual' | 'auto';
  /** What the AI may cost for this client in a calendar month, in dollars; the engine's default applies when missing. */
  spendCapUsd?: number;
}

export interface RunnerDeps {
  /** Runs the autopilot with these arguments and resolves with its exit code and the end of its output. */
  exec: (args: string[], onLine?: (line: string) => void) => Promise<{ code: number; tail: string }>;
  /** Hands the brand's approved posters to the publisher. */
  release: (brandDir: string, options: { brand: string; weekFiles: string[] }) => Promise<number>;
  /** How a client's posters are approved right now, asked at each release so a change of setting takes effect at the next tick. Missing means a person approves. */
  approvalMode?: (brand: string) => 'manual' | 'auto';
  /** Tells the owner about a poster that is running out of time or has missed it (lead-time.ts); resolves to whether it was delivered. Missing means nobody is told. */
  notify?: (notice: LeadTimeNotice) => Promise<boolean>;
  now?: () => Date;
  /** Whether publishing is switched on; release is skipped, and says so, when it is not. */
  publishingEnabled: () => boolean;
  /** A release pass that runs beside a working batch (see releaseNow) writes none of the campaign records: the batch's own run owns them. */
  readOnlyState?: boolean;
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
      const singles = planBatches(plan).map((b) => ({ index: b.index, dates: b.dates.filter((d) => d >= today) })).filter((b) => b.dates.length > 0);
      // Each carousel day of a plan with a weekly carousel is its own batch, made after the single posters.
      const carousels = planCarouselDates(plan).filter((d) => d >= today).map((date, n) => ({ index: singles.length + n, dates: [date], kind: 'carousel' as const }));
      const batches: Array<{ index: number; dates: string[]; kind?: 'carousel' }> = [...singles, ...carousels];
      if (batches.length === 0) { log(`${client.brand}: every day of the plan has already passed; nothing to make`); continue; }
      state = { id, brand: client.brand, siteBrand, site, plan, status: 'queued', batches: batches.map((b) => ({ index: b.index, dates: b.dates, ...(b.kind ? { kind: b.kind } : {}), status: 'pending' as const })), createdAt: stamp(deps), updatedAt: stamp(deps) };
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
      log(batch.kind === 'carousel' ? `${client.brand}: making the carousel for ${batch.dates[0]}` : `${client.brand}: making ${batch.dates.length} poster${batch.dates.length === 1 ? '' : 's'} for ${batch.dates[0]}${batch.dates.length > 1 ? ` to ${batch.dates.at(-1)}` : ''}`);
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
        const limits = { requireAuthenticLogo: client.requireAuthenticLogo === true, ...(client.spendCapUsd !== undefined ? { monthCapUsd: client.spendCapUsd } : {}) };
        outcome = await deps.exec(batch.kind === 'carousel' ? carouselArgsFor(plan, site, batch.dates[0] as string, limits) : autopilotArgsFor(plan, site, { index: batch.index, dates: batch.dates }, limits), onLine);
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

/** How many of a plan's posters the owner has approved, left waiting or turned down, read from the review queue by the plan's own week files. */
function reviewCounts(brandDir: string, site: string, state: CampaignState): { review?: { approved: number; pending: number; rejected: number } } {
  const weekFiles = new Set(state.batches.flatMap((b) => (b.weekFile ? [b.weekFile] : [])));
  if (weekFiles.size === 0 || !existsSync(join(brandDir, 'reviews.jsonl'))) return {};
  try {
    const counts = { approved: 0, pending: 0, rejected: 0 };
    for (const item of new ReviewStore(brandDir, site).list()) {
      if (!weekFiles.has(basename(item.version.planFile))) continue;
      if (item.status === 'approved') counts.approved += 1;
      else if (item.status === 'pending') counts.pending += 1;
      else if (item.status === 'rejected' || item.status === 'blocked') counts.rejected += 1;
    }
    return { review: counts };
  } catch {
    // A queue that cannot be read is not guessed at.
    return {};
  }
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
  release?: { state: 'off' } | { state: 'on'; posts: number } | { state: 'failed'; reason: string };
  /** Where the owner has got to with this plan's posters: how many are approved, still waiting for a decision, or turned down. Missing when it cannot be read. */
  review?: { approved: number; pending: number; rejected: number };
  batches: Array<{ index: number; dates: string[]; kind?: 'carousel'; status: BatchStatus; stage?: BatchStage; stoppedAt?: BatchStage; detail?: string; drawn?: number; queued?: number; startedAt?: string; finishedAt?: string; failure?: string; note?: string }>;
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
        ...(state.releaseNote?.startsWith('release failed') ? { release: { state: 'failed' as const, reason: state.releaseNote.replace(/^release failed:\s*/, '').slice(0, 240) } } : state.released ? { release: { state: 'on' as const, posts: state.released.posts } } : state.releaseNote ? { release: { state: 'off' as const } } : {}),
        ...reviewCounts(join(brandsRoot, site), site, state),
        batches: state.batches.map((b) => ({
          index: b.index, dates: b.dates, status: b.status, ...(b.kind ? { kind: b.kind } : {}),
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
/** The name every automatic approval is recorded under: the review history then shows plainly that the system, not a person, approved the version. */
export const AUTO_APPROVER = 'auto-checks';

/**
 * Approves the waiting posters of a client that is on automatic approval. Only a version that is still pending is approved: one the checks blocked, a person
 * rejected or a newer version replaced is left alone, and so is a poster whose time has already passed (it would only be missed). The version approved is
 * the exact one the checks passed; the approval is hash-bound like a person's. A carousel is never approved here. Returns how many were approved and how many were left.
 */
export function autoApprove(brandDir: string, site: string, weekFiles: readonly string[], now: Date, log: (m: string) => void = () => undefined): { approved: number; left: number } {
  const wanted = new Set(weekFiles);
  const dates = new Map<string, number>();
  const dateOf = (planFile: string, postId: string): number | undefined => {
    const name = basename(planFile);
    if (!dates.has(`${name}|`)) {
      dates.set(`${name}|`, 0);
      try {
        const plan = JSON.parse(readFileSync(join(brandDir, name), 'utf8')) as { posts?: Array<{ id?: unknown; date?: unknown }> };
        for (const p of plan.posts ?? []) if (typeof p.id === 'string' && typeof p.date === 'string') dates.set(`${name}|${p.id}`, Date.parse(p.date));
      } catch {
        // an unreadable plan file means no date is known, and nothing is approved on a guess
      }
    }
    return dates.get(`${name}|${postId}`);
  };
  const store = new ReviewStore(brandDir, site, () => now);
  let approved = 0;
  let left = 0;
  for (const item of store.list({ status: 'pending' })) {
    if (!wanted.has(basename(item.version.planFile))) continue;
    // A carousel is always approved by the owner, as a whole, in Review: the system's checks never approve one, not even for a client on automatic approval.
    if (item.version.carousel) { left += 1; continue; }
    const at = dateOf(item.version.planFile, item.version.postId);
    if (at === undefined || !Number.isFinite(at) || at <= now.getTime()) { left += 1; continue; }
    try {
      store.approve(item.version.versionId, AUTO_APPROVER);
      approved += 1;
    } catch (error) {
      left += 1;
      log(`${site}: ${item.version.versionId} was not approved automatically: ${error instanceof ReviewError ? error.message : String(error)}`);
    }
  }
  return { approved, left };
}

export async function releaseCampaigns(brandsRoot: string, deps: RunnerDeps): Promise<CampaignState[]> {
  const log = deps.log ?? (() => undefined);
  const released: CampaignState[] = [];
  const owners = new ProductBrands(brandsRoot);
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
        if (state.releaseNote !== 'publishing is switched off, so nothing was released' && !deps.readOnlyState) { state.releaseNote = 'publishing is switched off, so nothing was released'; await writeState(file, state); }
        continue;
      }
      groups.set(state.brand, [...(groups.get(state.brand) ?? []), { file, state }]);
    }
    for (const [client, members] of groups) {
      const weekFiles = [...new Set(members.flatMap(({ state }) => state.batches.flatMap((b) => (b.weekFile ? [b.weekFile] : []))))];
      try {
        // A client on automatic approval has the posters that passed every check approved here, just before they are handed over.
        // A brand a product owns is never approved by the system, whatever its setting says: only its own customer approves.
        if ((deps.approvalMode?.(client) ?? 'manual') === 'auto' && !owners.has(siteBrand) && !owners.has(client)) {
          const result = autoApprove(join(brandsRoot, siteBrand), siteBrand, weekFiles, deps.now?.() ?? new Date(), log);
          if (result.approved > 0) log(`${client}: ${result.approved} poster${result.approved === 1 ? '' : 's'} approved automatically after the checks`);
        }
        // Posters still waiting that are about to run out of time, or already have, are told to the owner once each.
        if (deps.notify) {
          try {
            const told = await checkLeadTime(join(brandsRoot, siteBrand), siteBrand, client, weekFiles, deps.now?.() ?? new Date(), deps.notify);
            if (told.length > 0) log(`${client}: ${told.length} notice${told.length === 1 ? '' : 's'} sent about posters waiting for approval`);
          } catch (error) {
            // A notice that cannot be worked out must never stop the release.
            log(`${client}: the lead-time check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 320));
          }
        }
        const posts = await deps.release(join(brandsRoot, siteBrand), { brand: client, weekFiles });
        let changed = false;
        for (const { file, state } of members) {
          if (state.released?.posts !== posts || state.releaseNote) {
            changed = true;
            state.released = { at: stamp(deps), posts };
            delete state.releaseNote;
            state.updatedAt = stamp(deps);
            if (!deps.readOnlyState) await writeState(file, state);
          }
          released.push(state);
        }
        if (changed) log(`${client}: ${posts} approved post${posts === 1 ? '' : 's'} are with the publisher`);
      } catch (error) {
        for (const { file, state } of members) {
          state.releaseNote = `release failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300);
          if (!deps.readOnlyState) await writeState(file, state);
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

/**
 * Runs `work` while holding the release lock, waiting up to `waitMs` for it. Only one release pass writes the publisher's schedule at a time (it is one
 * shared file); the timer's pass and the pass an approval asks for take turns. Returns false when the lock could not be had in time.
 */
export async function withReleaseLock(path: string, waitMs: number, work: () => Promise<void>, pollMs = 500): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const giveBack = await acquireLease(path);
    if (giveBack) {
      try {
        await work();
      } finally {
        await giveBack();
      }
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'release-only': { type: 'boolean', default: false },
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
    clients = (raw.clients ?? []).flatMap((c) => (typeof c['brand'] === 'string' && typeof c['website'] === 'string' && (Array.isArray(c['plans']) ? c['plans'].length > 0 : c['plan'] !== undefined) ? [{ brand: c['brand'], website: c['website'], plans: Array.isArray(c['plans']) ? (c['plans'] as unknown[]) : [c['plan']], ...(c['requireAuthenticLogo'] === true ? { requireAuthenticLogo: true } : {}), ...(c['approvalMode'] === 'auto' ? { approvalMode: 'auto' as const } : {}), ...(typeof c['spendCapUsd'] === 'number' && Number.isFinite(c['spendCapUsd']) && c['spendCapUsd'] > 0 ? { spendCapUsd: c['spendCapUsd'] } : {}) }] : []));
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
    approvalMode: (brand) => clients.find((c) => c.brand === brand)?.approvalMode ?? 'manual',
    // A release asked for by an approval only hands over what is approved: it tells nobody and leaves the campaign records to the run that owns them.
    ...(values['release-only'] ? { readOnlyState: true } : { notify: ntfySender() }),
    log: (m) => console.log(m),
  };
  await mkdir(brandsRoot, { recursive: true });
  if (values['release-only']) {
    // Does not wait for a batch being made (that can take an hour): approved posters reach the calendar in seconds.
    const done = await withReleaseLock(join(brandsRoot, RELEASE_LOCK), 5 * 60_000, async () => { await releaseCampaigns(brandsRoot, deps); });
    if (!done) throw new Error('another release kept working for five minutes; asking again will release');
    return;
  }
  // One runner at a time: a second one started by the timer while this runs leaves at once instead of repeating work.
  const giveBack = await acquireLease(join(brandsRoot, '.campaigns.lease'));
  if (!giveBack) { console.log('another campaign runner is working; leaving it to finish'); return; }
  try {
    await makeCampaigns(clients, brandsRoot, deps);
    const released = await withReleaseLock(join(brandsRoot, RELEASE_LOCK), RELEASE_WAIT_MS, async () => { await releaseCampaigns(brandsRoot, deps); });
    if (!released) console.log('another release is working; the next run will release');
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
