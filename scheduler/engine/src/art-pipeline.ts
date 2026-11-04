/**
 * Wiring art direction into the weekly run, with the guards that keep it from spending or publishing by accident:
 * it is off unless the run asks for it AND the tenant has enabled it in `art.json`; an env kill switch overrides both;
 * a paid dry run needs its own flag; one tenant has one writer at a time (a lock file); files are written atomically.
 * An art plan names its mode ("art_v1") and every post either carries its art direction or says why it has none, so
 * nothing slips back to the older renderer unnoticed. Rendered posters wait for human approval before they are scheduled,
 * and only reviewed posters count towards the brand's accepted art history.
 */
import { judgePictures } from './visual-strategy.ts';
import type { Judge } from './semantic-verifier.ts';
import type { EvidenceFact } from './evidence.ts';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiConfig } from './ai.ts';
import { ART_PROMPT_VERSION, directWeek, type DirectedPost, type DirectorSettings } from './art-director.ts';
import { planShortlists, postFacts, type ArtRecord } from './art-options.ts';
import { finalizeDirections, renderCandidates, type PlanStatus, type Reason, type Resolution } from './art-resolve.ts';
import type { Brand, PlannedPost, WeekPlan } from './content.ts';

export class ArtNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtNotAllowedError';
  }
}

/** What a tenant has agreed to, kept in `brands/<slug>/art.json`. Absent means art direction is not enabled. */
export interface ArtTenantSettings {
  enabled: boolean;
  /** Let an art post whose rendering fails fall back to the older renderer. Off unless set. */
  fallbackToLegacy: boolean;
  maxCostUsd?: number;
  maxPostsPerBatch?: number;
}

export async function loadArtSettings(brandDir: string): Promise<ArtTenantSettings> {
  let text: string;
  try {
    text = await readFile(join(brandDir, 'art.json'), 'utf8');
  } catch {
    return { enabled: false, fallbackToLegacy: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ArtNotAllowedError('art.json is not valid JSON');
  }
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof r['enabled'] !== 'boolean') throw new ArtNotAllowedError('art.json: "enabled" must be true or false');
  if (r['fallbackToLegacy'] !== undefined && typeof r['fallbackToLegacy'] !== 'boolean') throw new ArtNotAllowedError('art.json: "fallbackToLegacy" must be true or false');
  for (const key of ['maxCostUsd', 'maxPostsPerBatch'] as const) {
    if (r[key] !== undefined && (typeof r[key] !== 'number' || !Number.isFinite(r[key]) || (r[key] as number) <= 0)) throw new ArtNotAllowedError(`art.json: "${key}" must be a positive number`);
  }
  return {
    enabled: r['enabled'],
    fallbackToLegacy: r['fallbackToLegacy'] === true,
    ...(typeof r['maxCostUsd'] === 'number' ? { maxCostUsd: r['maxCostUsd'] } : {}),
    ...(typeof r['maxPostsPerBatch'] === 'number' ? { maxPostsPerBatch: r['maxPostsPerBatch'] } : {}),
  };
}

/** Throws, naming the reason, unless this run may make an art direction call. */
export function assertArtAllowed(input: { settings: ArtTenantSettings; env: Readonly<Record<string, string | undefined>>; dryRun: boolean; allowPaidAi: boolean }): void {
  if (input.env['ART_DIRECTION_DISABLED'] === '1') throw new ArtNotAllowedError('art direction is switched off (ART_DIRECTION_DISABLED=1)');
  if (!input.settings.enabled) throw new ArtNotAllowedError('art direction is not enabled for this brand: set {"enabled": true} in its art.json first');
  if (input.dryRun && !input.allowPaidAi) throw new ArtNotAllowedError('a dry run with art direction makes a paid model call: add --allow-paid-ai to allow it');
}

export interface ArtReport {
  status: PlanStatus;
  model: string;
  promptVersion: number;
  requests: number;
  counts: { directed: number; repaired: number; fallback: number; failed: number };
  flags: string[];
  notes: string[];
  posts: Array<{ postId: string; resolution?: Resolution; requestedOptionId?: string; actualOptionId?: string; status?: string; reasons: Reason[] }>;
}

/** Directs a plan's posts in one batched call and returns the plan in art_v1 mode, every post carrying its art direction or the reasons it has none. */
export async function artDirectPlan(input: {
  ai: AiConfig;
  plan: WeekPlan;
  brand: Brand;
  /** The brand's art records that count for variety: accepted and still-pending ones. */
  history: readonly ArtRecord[];
  settings: ArtTenantSettings;
  fetchFn?: typeof fetch;
  director?: DirectorSettings;
  /** The brand's evidence facts, so a post built on a commercial fact may show it as an offer. */
  facts?: readonly EvidenceFact[];
  /** Optional: a judge asked once, before any picture is bought, whether each picture idea explains its post's message. */
  pictureJudge?: Judge;
}): Promise<{ plan: WeekPlan; report: ArtReport }> {
  const { plan, brand, history } = input;
  const basic = plan.posts.map((post) => postFacts(post, brand, input.facts ?? []));
  // Optional, before any picture is paid for: a post whose picture idea a model cannot see explaining its message goes to a picture-free treatment.
  const facts = input.pictureJudge ? await judgePictures(plan.posts.map((post) => ({ id: post.id, headline: post.headline, subline: post.subline, ...(post.concept ? { concept: post.concept } : {}) })), basic, input.pictureJudge) : basic;
  const planned = planShortlists({ posts: facts, history });
  const posts: DirectedPost[] = plan.posts.map((post, i) => ({
    id: post.id,
    facts: facts[i] as ReturnType<typeof postFacts>,
    ...(post.hook ? { hook: post.hook } : {}),
    ...(post.pillar ? { pillar: post.pillar } : {}),
    ...(post.concept ? { concept: post.concept } : {}),
    shortlist: planned[i]?.shortlist ?? [],
    eligible: planned[i]?.eligible ?? [],
  }));

  const outcome = await directWeek({
    ai: input.ai,
    posts,
    brand: { font: brand.font, ...(brand.visualStyle ? { visualStyle: brand.visualStyle } : {}), hasIdentity: Boolean(brand.identity && brand.identity.kind !== 'name-only'), hasCta: Boolean(brand.cta) },
    history,
    settings: { ...(input.settings.maxCostUsd !== undefined ? { maxCostUsd: input.settings.maxCostUsd } : {}), ...(input.settings.maxPostsPerBatch !== undefined ? { maxPostsPerBatch: input.settings.maxPostsPerBatch } : {}), ...input.director },
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
  });
  const finalized = finalizeDirections({ posts, outcome, history, brand });

  const readyById = new Map(finalized.ready.map((r) => [r.postId, r]));
  const failedById = new Map(finalized.failed.map((f) => [f.postId, f]));
  const running: ArtRecord[] = [...history];
  const annotated: PlannedPost[] = plan.posts.map((post, i) => {
    const ready = readyById.get(post.id);
    if (!ready) return { ...post, artFailure: { reasons: (failedById.get(post.id)?.reasons ?? [{ code: 'missing_direction', severity: 'warning', message: 'not directed' }]).map((r) => `${r.code}: ${r.message}`) } };
    const directed = posts[i] as DirectedPost;
    const candidates = renderCandidates({ post: directed, ready, history: running, brand });
    running.push(ready.record);
    const figure = facts[i]?.figure;
    const offer = facts[i]?.offer;
    return { ...post, art: { resolution: ready.resolution, candidates, ...(figure ? { figure } : {}), ...(offer ? { offer } : {}) }, approval: { status: 'pending' } };
  });

  const report: ArtReport = {
    status: finalized.status,
    model: input.ai.textModel,
    promptVersion: ART_PROMPT_VERSION,
    requests: outcome.requests,
    counts: {
      directed: finalized.ready.filter((r) => r.resolution === 'directed').length,
      repaired: finalized.ready.filter((r) => r.resolution === 'repaired').length,
      fallback: finalized.ready.filter((r) => r.resolution === 'fallback').length,
      failed: finalized.failed.length,
    },
    flags: finalized.quality.flags,
    notes: outcome.notes,
    posts: plan.posts.map((post) => {
      const ready = readyById.get(post.id);
      const failed = failedById.get(post.id);
      return ready
        ? { postId: post.id, resolution: ready.resolution, ...(ready.requestedOptionId ? { requestedOptionId: ready.requestedOptionId } : {}), actualOptionId: ready.actualOptionId, status: ready.status, reasons: ready.reasons }
        : { postId: post.id, reasons: failed?.reasons ?? [] };
    }),
  };
  return { plan: { ...plan, renderMode: 'art_v1', posts: annotated }, report };
}

/** One entry of a brand's art history: the art record of a rendered poster and where its review stands. */
export interface ArtHistoryEntry {
  postId: string;
  status: 'pending' | 'approved' | 'rejected';
  record: ArtRecord;
}

interface WithArtHistory {
  weeks: Array<{ art?: ArtHistoryEntry[] }>;
}

/** The records that steer variety for the next plan: approved posters and those still awaiting review; rejected ones never count. */
export function readArtHistory(history: WithArtHistory): ArtRecord[] {
  return history.weeks.flatMap((w) => (w.art ?? []).filter((e) => e.status !== 'rejected').map((e) => e.record));
}

/** Writes a file so that a reader sees the old content or the new, never half of it. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, content);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

/** Takes the tenant's lock, or throws if another run holds it (a lock older than six hours is taken as left by a crash). Returns the release function. */
export async function acquireTenantLock(brandDir: string, now: () => number = Date.now): Promise<() => Promise<void>> {
  const path = join(brandDir, '.autopilot.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }));
      await handle.close();
      return async () => {
        await rm(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age = now() - (await stat(path).then((s) => s.mtimeMs).catch(() => now()));
      if (age < STALE_LOCK_MS) throw new ArtNotAllowedError(`another run holds the lock for this brand (${path}); wait for it to finish or remove the file if it crashed`);
      await rm(path, { force: true });
    }
  }
  throw new ArtNotAllowedError(`could not take the lock for this brand (${path})`);
}
