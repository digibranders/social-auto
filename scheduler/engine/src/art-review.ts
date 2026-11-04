/**
 * Review of art-directed posters, and what it does to the brand's art history. After a run, each rendered poster is recorded
 * as "pending" with the art record of the candidate that ACTUALLY rendered; a person approves or rejects it, and only then is
 * it scheduled or exported. A rejected poster stops counting towards variety. All writes are atomic and repeating any step
 * changes nothing.
 *
 *   node src/art-review.ts --brand brands/acme --plan week-02.json --list
 *   node src/art-review.ts --brand brands/acme --plan week-02.json --post p1 --approve [--by name]
 *   node src/art-review.ts --brand brands/acme --plan week-02.json --post p1 --reject --reason "text too small"
 */
import { access, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeFileAtomic, type ArtHistoryEntry } from './art-pipeline.ts';
import { parseWeekPlan, type PostApproval } from './content.ts';
import type { PostRenderRecord } from './render.ts';

interface HistoryFile {
  weeks: Array<{ file: string; art?: ArtHistoryEntry[] } & Record<string, unknown>>;
}

export const outDirFor = (brandDir: string, planFile: string): string => resolve('out', basename(brandDir), basename(planFile, '.json'));

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

async function readRenderReport(outDir: string): Promise<PostRenderRecord[]> {
  try {
    return await readJsonFile<PostRenderRecord[]>(join(outDir, 'render-report.json'));
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Records the art of every poster that rendered as pending review in the plan's history entry. Existing entries (and their review state) are kept, so repeating it adds nothing. */
export async function recordRenderedArt(input: { brandDir: string; planFile: string; outDir?: string }): Promise<number> {
  const historyPath = join(input.brandDir, 'history.json');
  const history = await readJsonFile<HistoryFile>(historyPath);
  const week = history.weeks.find((w) => w.file === input.planFile);
  if (!week) throw new Error(`history.json has no entry for ${input.planFile}`);
  const report = await readRenderReport(input.outDir ?? outDirFor(input.brandDir, input.planFile));
  const entries = week.art ?? [];
  let added = 0;
  for (const rec of report) {
    if (rec.status === 'render_failed' || !rec.record || rec.fallback === 'legacy') continue;
    if (entries.some((e) => e.postId === rec.postId)) continue;
    entries.push({ postId: rec.postId, status: 'pending', record: rec.record });
    added += 1;
  }
  if (added > 0) {
    week.art = entries;
    await writeFileAtomic(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  }
  return added;
}

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

/** Approves or rejects one art-directed poster, in the plan file and in the art history. */
export async function setApproval(input: {
  brandDir: string;
  planFile: string;
  postId: string;
  decision: 'approve' | 'reject';
  reason?: string;
  by?: string;
  outDir?: string;
  now?: () => Date;
}): Promise<PostApproval> {
  const planPath = join(input.brandDir, input.planFile);
  const raw = await readJsonFile<{ posts?: Array<Record<string, unknown>> }>(planPath);
  const plan = parseWeekPlan(raw, input.planFile);
  const post = plan.posts.find((p) => p.id === input.postId);
  if (!post) throw new ReviewError(`${input.planFile} has no post "${input.postId}"`);
  if (plan.renderMode !== 'art_v1' && !post.art) throw new ReviewError(`${input.postId} is not an art-directed post, so it needs no review`);
  if (input.decision === 'reject' && !input.reason?.trim()) throw new ReviewError('a rejection needs a reason');

  const outDir = input.outDir ?? outDirFor(input.brandDir, input.planFile);
  const report = await readRenderReport(outDir);
  const rendered = report.find((r) => r.postId === input.postId);
  if (input.decision === 'approve') {
    if (!rendered || rendered.status === 'render_failed' || rendered.fallback === 'legacy') throw new ReviewError(`${input.postId} has no verified art-directed render to approve`);
    if (!(await exists(join(outDir, `${input.postId}.jpg`)))) throw new ReviewError(`${input.postId} has no poster file to approve`);
  }

  const approval: PostApproval = {
    status: input.decision === 'approve' ? 'approved' : 'rejected',
    at: (input.now?.() ?? new Date()).toISOString(),
    ...(input.by?.trim() ? { by: input.by.trim() } : {}),
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  };
  const target = raw.posts?.find((p) => p['id'] === input.postId);
  if (!target) throw new ReviewError(`${input.planFile} has no post "${input.postId}"`);
  target['approval'] = approval;
  await writeFileAtomic(planPath, `${JSON.stringify(raw, null, 2)}\n`);

  const historyPath = join(input.brandDir, 'history.json');
  const history = await readJsonFile<HistoryFile>(historyPath);
  const week = history.weeks.find((w) => w.file === input.planFile);
  if (week) {
    const entries = week.art ?? [];
    const entry = entries.find((e) => e.postId === input.postId);
    if (entry) entry.status = approval.status;
    else if (rendered?.record && rendered.fallback !== 'legacy' && rendered.status !== 'render_failed') entries.push({ postId: input.postId, status: approval.status, record: rendered.record });
    week.art = entries;
    await writeFileAtomic(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  }
  return approval;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { brand: { type: 'string' }, plan: { type: 'string' }, post: { type: 'string' }, approve: { type: 'boolean', default: false }, reject: { type: 'boolean', default: false }, reason: { type: 'string' }, by: { type: 'string' }, list: { type: 'boolean', default: false } },
  });
  if (!values.brand || !values.plan) throw new Error('Usage: --brand <dir> --plan <week-NN.json> (--list | --post <id> --approve | --post <id> --reject --reason <text>) [--by <name>]');
  const brandDir = resolve(values.brand);
  if (values.list) {
    const plan = parseWeekPlan(await readJsonFile(join(brandDir, values.plan)), values.plan);
    const report = await readRenderReport(outDirFor(brandDir, values.plan));
    for (const post of plan.posts) {
      const rec = report.find((r) => r.postId === post.id);
      console.log(`${post.id}  ${post.approval?.status ?? (post.art ? 'pending' : 'n/a')}  render:${rec?.status ?? 'not rendered'}${rec?.optionId ? `  ${rec.optionId}` : ''}${post.artFailure ? `  no art: ${post.artFailure.reasons.join('; ')}` : ''}`);
    }
    return;
  }
  if (!values.post || values.approve === values.reject) throw new Error('give --post <id> and exactly one of --approve or --reject');
  const approval = await setApproval({ brandDir, planFile: values.plan, postId: values.post, decision: values.approve ? 'approve' : 'reject', ...(values.reason ? { reason: values.reason } : {}), ...(values.by ? { by: values.by } : {}) });
  console.log(`${values.post}: ${approval.status}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
