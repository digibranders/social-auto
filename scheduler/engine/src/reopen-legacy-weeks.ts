/**
 * One-time repair for weeks drawn under the old whole-week rule. Before the per-post lock, drawing a week made every post of it final, kept or not. This lists those weeks and, with
 * --apply, makes each follow the per-post rule: the kept posts stay drawn, and the posts that were not kept (whose day has not passed) are open again, so the customer can decide them.
 * The week's old draw job is told which posts it drew, so a later draw of the open ones is not taken for a repeat of it.
 *
 *   node src/reopen-legacy-weeks.ts --brands brands [--jobs jobs] [--brand <slug>]            lists what would be reopened; changes nothing
 *   node src/reopen-legacy-weeks.ts --brands brands [--jobs jobs] [--brand <slug>] --apply    does it
 *
 * Safe to run twice: a week already repaired is not listed again. Run it on the engine's own folders (the same --brands and --jobs the review service uses).
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CopyStage, weekOfPost, weeksOf, type CopyBatch } from './copy-stage.ts';

export interface LegacyWeek {
  brand: string;
  planFile: string;
  week: string;
  /** The posts that stay locked as drawn (kept, or whose day has passed). */
  locked: string[];
  /** The posts that would be open again. */
  open: string[];
}

/** The weeks of a batch drawn under the old rule that have posts to reopen. Pure. */
export function legacyWeeks(brand: string, batch: CopyBatch, today: string): LegacyWeek[] {
  if (batch.closedAt) return [];
  const weeks = weeksOf(batch);
  return weeks.flatMap((week) => {
    const drawnWhole = batch.weekDrawn?.[week] !== undefined || (batch.drawnAt !== undefined && batch.weekLapsed?.[week] === undefined);
    if (!drawnWhole || batch.weekLapsed?.[week] !== undefined) return [];
    const inWeek = batch.posts.filter((p) => weekOfPost(p) === week);
    const open = inWeek.filter((p) => p.drawnAt === undefined && p.state !== 'kept' && p.date !== undefined && p.date > today).map((p) => p.postId);
    if (open.length === 0) return [];
    return [{ brand, planFile: batch.planFile, week, locked: inWeek.filter((p) => !open.includes(p.postId)).map((p) => p.postId), open }];
  });
}

/** Tells a finished whole-week draw job which posts it drew, so it is no longer read as "the whole week was asked for". Returns how many job records changed. */
export function tellLegacyJobs(jobsDir: string, found: Pick<LegacyWeek, 'brand' | 'planFile' | 'week' | 'locked'>): number {
  if (!existsSync(jobsDir)) return 0;
  let changed = 0;
  for (const name of readdirSync(jobsDir).filter((f) => f.endsWith('.json'))) {
    const file = join(jobsDir, name);
    let job: Record<string, unknown>;
    try {
      job = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (job['kind'] !== 'draw' || job['brand'] !== found.brand || job['planFile'] !== found.planFile || job['week'] !== found.week || job['postIds'] !== undefined) continue;
    if (job['state'] === 'queued' || job['state'] === 'running') continue;
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ ...job, postIds: found.locked }, null, 2)}\n`);
    renameSync(temp, file);
    changed += 1;
  }
  return changed;
}

export interface ReopenOptions {
  brandsRoot: string;
  jobsDir: string;
  brand?: string;
  apply: boolean;
  today: string;
  log?: (line: string) => void;
}

export function reopenLegacyWeeks(options: ReopenOptions): LegacyWeek[] {
  const log = options.log ?? (() => undefined);
  const found: LegacyWeek[] = [];
  const brands = readdirSync(options.brandsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && (options.brand === undefined || d.name === options.brand)).map((d) => d.name);
  for (const brand of brands) {
    let stage: CopyStage;
    let batches: CopyBatch[];
    try {
      stage = new CopyStage(join(options.brandsRoot, brand), brand);
      batches = stage.list();
    } catch {
      continue;
    }
    for (const batch of batches) {
      for (const week of legacyWeeks(brand, batch, options.today)) {
        found.push(week);
        log(`${brand} ${week.planFile} week ${week.week}: stays drawn ${week.locked.join(', ') || '-'}; ${options.apply ? 'reopened' : 'would reopen'} ${week.open.join(', ')}`);
        if (options.apply) {
          const done = stage.reopenLegacyWeek(week.planFile, week.week, options.today);
          if (done.opened.length > 0) tellLegacyJobs(options.jobsDir, { ...week, locked: done.locked });
        }
      }
    }
  }
  return found;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { brands: { type: 'string', default: 'brands' }, jobs: { type: 'string' }, brand: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  const brandsRoot = resolve(values.brands);
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const found = reopenLegacyWeeks({ brandsRoot, jobsDir: resolve(values.jobs ?? join(brandsRoot, '..', 'jobs')), ...(values.brand ? { brand: values.brand } : {}), apply: values.apply, today, log: (l) => console.log(l) });
  console.log(`${found.length} week${found.length === 1 ? '' : 's'} ${values.apply ? 'reopened' : 'would be reopened (run again with --apply to do it)'}`);
}
