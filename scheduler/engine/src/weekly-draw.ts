/**
 * The weekly draw of a product's customer. A written batch of several weeks is drawn one week at a time: the first week when the customer asks, every later
 * week by the system on the Thursday before it begins, at 10:00 India time, for the topics the customer kept in it, and only when the week still has room for
 * its pictures (the weekly limit): only the kept posts that have no picture yet and whose day is ahead, each made final on its own, so the rest of the week stays open and what she
 * keeps later is drawn when she asks. A week whose time passed is given up (lapsed) unless a draw of it is still running. Nothing is ever approved here: the pictures wait for the customer.
 */
import { join } from 'node:path';
import { CopyStage, drawCandidates, weekOfPost, weeksOf, type CopyBatch } from './copy-stage.ts';
import { readConnected } from './connected-networks.ts';
import { planEnded } from './plan-end.ts';
import type { JobStore } from './job-store.ts';
import { isNetwork, type Network } from './networks.ts';
import type { ProductBrands } from './product-brands.ts';

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** The moment a week begins: Monday 00:00 India time. */
export const weekStartMs = (monday: string): number => Date.parse(`${monday}T00:00:00Z`) - IST_OFFSET_MS;
/** The moment a week ends: the next Monday 00:00 India time. */
export const weekEndMs = (monday: string): number => weekStartMs(monday) + 7 * DAY_MS;
/** When a week is drawn by the system: the Thursday before it begins, 10:00 India time. */
export const drawDueMs = (monday: string): number => weekStartMs(monday) - 4 * DAY_MS + 10 * 3_600_000;

/** The pictures a week's draw needs for each network: one for every kept post of the week for every connected network it is written for, less what already exists. */
export function neededPictures(batch: Pick<CopyBatch, 'posts'>, week: string | undefined, made: ReadonlySet<string>, connected: ReadonlySet<Network> | null): Partial<Record<Network, number>> {
  const needed: Partial<Record<Network, number>> = {};
  for (const post of batch.posts.filter((p) => p.state === 'kept' && (week === undefined || weekOfPost(p) === week))) {
    for (const net of Object.keys(post.captions ?? {})) if (isNetwork(net) && (connected === null || connected.has(net)) && !made.has(`${post.postId}|${net}`)) needed[net] = (needed[net] ?? 0) + 1;
  }
  return needed;
}

export interface WeeklyAction {
  brand: string;
  planFile: string;
  week: string;
  action: 'drawing' | 'lapsed' | 'no_room';
  /** For `no_room`: why, in the words the customer would be told. */
  reason?: string;
}

export interface WeeklyDeps {
  brandsRoot: string;
  jobs: JobStore;
  owners: ProductBrands;
  now: Date;
  /** The pictures already made for a plan (`<postId>|<network>`). */
  made: (brand: string, planFile: string) => ReadonlySet<string>;
  /** Null when the week has room for these pictures; else the reason there is none. */
  room: (brand: string, needed: Partial<Record<Network, number>>) => string | null;
  /** The website of the brand, or null when it has none saved. */
  siteOf: (brand: string) => string | null;
  /** Makes sure approved pictures of the plan can reach the calendar (the same record the customer's own draw makes). */
  register: (brand: string, planFile: string, site: string) => void;
  /** Called when a week is given up, so the product can tell the customer (written to the expiry log). */
  onLapse?: (brand: string, planFile: string, week: string) => void;
  /** Batches the customer chose automatic posting for (every channel of the batch): their first week is drawn at once, without waiting to be asked. */
  automatic?: (brand: string, batch: CopyBatch) => boolean;
}

export const WEEKLY_DRAW_BY = 'system:weekly-draw';

/** One pass over every product-owned brand. Safe to run as often as wanted: a week is only ever asked for once. */
export function runWeeklyDraws(deps: WeeklyDeps): WeeklyAction[] {
  const actions: WeeklyAction[] = [];
  const now = deps.now.getTime();
  for (const brand of deps.owners.all()) {
    const brandDir = join(deps.brandsRoot, brand);
    // The paid period has ended: nothing is drawn for her, and a week is not given up either (it is still hers if she keeps or renews the plan).
    if (planEnded(brandDir, now)) continue;
    let stage: CopyStage;
    let batches: CopyBatch[];
    try {
      stage = new CopyStage(brandDir, brand);
      batches = stage.list();
    } catch {
      continue;
    }
    const connected = readConnected(brandDir);
    // Not told yet which networks are connected: nothing is drawn for this customer until it is.
    if (connected === null) continue;
    for (const batch of batches) {
      if (batch.closedAt || batch.drawnAt) continue;
      weeksOf(batch).forEach((week, index) => {
        if (batch.weekDrawn?.[week] !== undefined || batch.weekLapsed?.[week] !== undefined) return;
        try {
          const draws = deps.jobs.list({ brand }).filter((j) => j.kind === 'draw' && j.planFile === batch.planFile && j.week === week);
          const asked = draws.length > 0;
          const active = draws.filter((j) => j.state === 'queued' || j.state === 'running');
          // A week that ended is given up for good, unless a draw of it is still waiting or running (the draw settles that). Posts drawn before it ended stay as they are.
          if (now >= weekEndMs(week) && active.length === 0) {
            stage.markWeekLapsed(batch.planFile, week);
            actions.push({ brand, planFile: batch.planFile, week, action: 'lapsed' });
            // The customer is told only about a week nothing of which was drawn.
            if (!batch.posts.some((p) => weekOfPost(p) === week && p.drawnAt !== undefined)) deps.onLapse?.(brand, batch.planFile, week);
            return;
          }
          // The first week is the customer's to ask for (the system asks for it only when she chose automatic posting); the later ones are drawn on the Thursday before they begin, once: what she keeps after that is drawn only when she asks.
          if (index === 0 ? deps.automatic?.(brand, batch) !== true : now < drawDueMs(week)) return;
          if (asked) return;
          // The kept posts that have no picture yet and whose day is tomorrow or later; the rest of the week stays open.
          // The system's own draw is lenient about the day: a post for today is still drawn (it was kept in time; only the customer's asks need tomorrow or later).
          const yesterday = new Date(now + IST_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
          const ids = drawCandidates(batch, week, deps.made(brand, batch.planFile), yesterday);
          if (ids.length === 0) return;
          const reason = deps.room(brand, neededPictures({ posts: batch.posts.filter((p) => ids.includes(p.postId)) }, week, deps.made(brand, batch.planFile), connected));
          if (reason !== null) {
            actions.push({ brand, planFile: batch.planFile, week, action: 'no_room', reason });
            return;
          }
          const site = deps.siteOf(brand);
          if (site === null) return;
          deps.register(brand, batch.planFile, site);
          deps.jobs.enqueue({ kind: 'draw', brand, site, by: WEEKLY_DRAW_BY, planFile: batch.planFile, week, postIds: ids, auto: true });
          actions.push({ brand, planFile: batch.planFile, week, action: 'drawing' });
        } catch (error) {
          console.error(`weekly draw of ${brand} ${batch.planFile} ${week} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
  }
  return actions;
}

export interface CatchUpDeps {
  brandsRoot: string;
  jobs: JobStore;
  owners: ProductBrands;
  now: Date;
  /** The pictures already made for a plan (`<postId>|<network>`). */
  made: (brand: string, planFile: string) => ReadonlySet<string>;
  /** How many more pictures a channel may have this week (null: no limit). */
  roomFor: (brand: string, network: Network) => number | null;
  siteOf: (brand: string) => string | null;
}

export interface CatchUpAction {
  brand: string;
  planFile: string;
  postId: string;
  network: Network;
}

/**
 * Pictures a drawn topic still lacks for a connected network: a channel added later when this week had no room for all of them, or connected after the draw. They are drawn
 * as room comes, soonest topic first, up to the room left this week. A topic whose day has passed gets none. A try that failed for another reason than the limit is not asked
 * for again by the system (the customer decides), and one that is waiting or running is left alone.
 */
export function runCatchUpDraws(deps: CatchUpDeps): CatchUpAction[] {
  const actions: CatchUpAction[] = [];
  const today = new Date(deps.now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
  for (const brand of deps.owners.all()) {
    const brandDir = join(deps.brandsRoot, brand);
    if (planEnded(brandDir, deps.now.getTime())) continue;
    let batches: CopyBatch[];
    try {
      batches = new CopyStage(brandDir, brand).list();
    } catch {
      continue;
    }
    const connected = readConnected(brandDir);
    if (connected === null) continue;
    const jobs = deps.jobs.list({ brand }).filter((j) => j.kind === 'newnet');
    const wanting = new Map<Network, Array<{ planFile: string; postId: string; date: string }>>();
    for (const batch of batches) {
      if (batch.closedAt) continue;
      const made = deps.made(brand, batch.planFile);
      for (const post of batch.posts) {
        const week = weekOfPost(post);
        if (post.state !== 'kept' || !post.date || post.date < today || week === undefined || (batch.weekDrawn?.[week] === undefined && post.drawnAt === undefined)) continue;
        if (batch.notDrawn?.[post.postId] !== undefined) continue;
        if (![...made].some((k) => k.startsWith(`${post.postId}|`))) continue;
        for (const net of Object.keys(post.captions ?? {})) {
          if (!isNetwork(net) || !connected.has(net) || made.has(`${post.postId}|${net}`)) continue;
          const tries = jobs.filter((j) => j.planFile === batch.planFile && j.postId === post.postId && j.network === net);
          if (tries.some((j) => j.state === 'queued' || j.state === 'running')) continue;
          if (tries.some((j) => j.state === 'failed' && j.error?.code !== 'PICTURE_LIMIT_REACHED')) continue;
          if (tries.some((j) => j.state === 'succeeded')) continue;
          (wanting.get(net) ?? wanting.set(net, []).get(net) as Array<{ planFile: string; postId: string; date: string }>).push({ planFile: batch.planFile, postId: post.postId, date: post.date });
        }
      }
    }
    for (const [network, list] of wanting) {
      let room = deps.roomFor(brand, network) ?? Number.POSITIVE_INFINITY;
      const site = deps.siteOf(brand);
      if (site === null) continue;
      for (const topic of list.sort((a, b) => a.date.localeCompare(b.date) || a.postId.localeCompare(b.postId))) {
        if (room <= 0) break;
        room -= 1;
        deps.jobs.enqueue({ kind: 'newnet', brand, site, by: WEEKLY_DRAW_BY, planFile: topic.planFile, postId: topic.postId, network, auto: true });
        actions.push({ brand, planFile: topic.planFile, postId: topic.postId, network });
      }
    }
  }
  return actions;
}
