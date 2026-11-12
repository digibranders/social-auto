/**
 * The weekly draw of a product's customer. A written batch of several weeks is drawn one week at a time: the first week when the customer asks, every later
 * week by the system on the Thursday before it begins, at 10:00 India time, for the topics the customer kept in it, and only when the week still has room for
 * its pictures (the weekly limit). A week whose time passed without a draw is given up (lapsed). Nothing is ever approved here: the pictures wait for the customer.
 */
import { join } from 'node:path';
import { CopyStage, weekOfPost, weeksOf, type CopyBatch } from './copy-stage.ts';
import { readConnected } from './connected-networks.ts';
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
}

export const WEEKLY_DRAW_BY = 'system:weekly-draw';

/** One pass over every product-owned brand. Safe to run as often as wanted: a week is only ever asked for once. */
export function runWeeklyDraws(deps: WeeklyDeps): WeeklyAction[] {
  const actions: WeeklyAction[] = [];
  const now = deps.now.getTime();
  for (const brand of deps.owners.all()) {
    const brandDir = join(deps.brandsRoot, brand);
    let stage: CopyStage;
    let batches: CopyBatch[];
    try {
      stage = new CopyStage(brandDir, brand);
      batches = stage.list();
    } catch {
      continue;
    }
    const connected = readConnected(brandDir);
    for (const batch of batches) {
      if (batch.closedAt || batch.drawnAt) continue;
      weeksOf(batch).forEach((week, index) => {
        if (batch.weekDrawn?.[week] !== undefined || batch.weekLapsed?.[week] !== undefined) return;
        try {
          const asked = deps.jobs.list({ brand }).some((j) => j.kind === 'draw' && j.planFile === batch.planFile && j.week === week);
          // A week that ended without a draw is given up for good (one whose draw was asked for is the draw's to settle).
          if (now >= weekEndMs(week) && !asked) {
            stage.markWeekLapsed(batch.planFile, week);
            actions.push({ brand, planFile: batch.planFile, week, action: 'lapsed' });
            return;
          }
          // The first week is the customer's to ask for; the later ones are drawn on the Thursday before they begin.
          if (index === 0 || now < drawDueMs(week)) return;
          if (asked) return;
          if (!batch.posts.some((p) => p.state === 'kept' && weekOfPost(p) === week)) return;
          const reason = deps.room(brand, neededPictures(batch, week, deps.made(brand, batch.planFile), connected));
          if (reason !== null) {
            actions.push({ brand, planFile: batch.planFile, week, action: 'no_room', reason });
            return;
          }
          const site = deps.siteOf(brand);
          if (site === null) return;
          deps.register(brand, batch.planFile, site);
          deps.jobs.enqueue({ kind: 'draw', brand, site, by: WEEKLY_DRAW_BY, planFile: batch.planFile, week, auto: true });
          actions.push({ brand, planFile: batch.planFile, week, action: 'drawing' });
        } catch (error) {
          console.error(`weekly draw of ${brand} ${batch.planFile} ${week} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    }
  }
  return actions;
}
