/**
 * Automatic posting for a product's customer who chose it: she lets the system post without approving each poster first.
 *
 * It is the customer's own choice (the product records her consent and tells the poster service), kept per brand in `auto-posting.json` in the brand's folder, as the list
 * of channels she chose it for. A channel she connects later is not on the list until she chooses again, so what she agreed to is always what she saw.
 * While it is on, the system does the steps she would otherwise do, and only those, with every automatic check still in force:
 *   keep     a written topic that carries no warning from the checks is kept (a topic with a warning waits for her, as before)
 *   draw     the kept topics of the first week are drawn at once (the weekly draw does the later weeks on their Thursday, as always)
 *   (her own topic requests are never kept or approved here: her words are hers to confirm)
 *   approve  a picture that PASSED the checks is approved once its posting time is within the safety window (default 24 hours before), never before, so she
 *            can still look at it, change it or take it back until then; a picture the checks blocked is never approved, a carousel never is
 * Everything else is unchanged: the picture limits, the monthly spend limit, her pause, her right to reject a poster before it goes out.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readConnected } from './connected-networks.ts';
import { CopyStage, weekOfPost } from './copy-stage.ts';
import { isNetwork, type Network } from './networks.ts';
import type { ProductBrands } from './product-brands.ts';
import { ReviewStore } from './review-store.ts';

const FILE = 'auto-posting.json';
export const AUTO_POST_BY = 'system:auto-posting';
export const DEFAULT_SAFETY_HOURS = 24;
export const MAX_SAFETY_HOURS = 72;
const HOUR_MS = 3_600_000;

export interface AutoPosting {
  /** The channels the customer chose automatic posting for; empty means it is off. Only these channels' pictures are approved by the system. */
  channels: Network[];
  /** How many hours before a poster's posting time the system approves it; 0 approves as soon as it passed the checks. */
  safetyHours: number;
  /** Who agreed, and when; kept as the record of her choice. */
  consent: { by: string; at: string };
  updatedAt: string;
}

export class AutoPostingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoPostingError';
  }
}

export function readAutoPosting(brandDir: string): AutoPosting | null {
  const file = join(brandDir, FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AutoPosting>;
    if (!Array.isArray(raw.channels) || typeof raw.safetyHours !== 'number' || typeof raw.consent?.by !== 'string' || typeof raw.consent.at !== 'string') return null;
    return { channels: raw.channels.filter(isNetwork), safetyHours: raw.safetyHours, consent: { by: raw.consent.by, at: raw.consent.at }, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.consent.at };
  } catch {
    return null;
  }
}

/** Whether the customer has automatic posting on for any channel. */
export const isAutomatic = (setting: AutoPosting | null): boolean => setting !== null && setting.channels.length > 0;

/**
 * Sets the channels automatic posting is on for (an empty list switches it off). It needs the person who agreed. A channel that was already on keeps its first
 * consent; a channel added or a change of the window is recorded with who agreed and when. Posters already approved stay approved when a channel is taken off
 * (she can still take them back).
 */
export function writeAutoPosting(brandDir: string, input: { channels: readonly unknown[]; safetyHours?: number; by: string }, now: Date = new Date()): AutoPosting {
  const by = input.by.trim().slice(0, 80);
  if (by === '') throw new AutoPostingError('who agreed must be given');
  const safetyHours = input.safetyHours ?? DEFAULT_SAFETY_HOURS;
  if (!Number.isInteger(safetyHours) || safetyHours < 0 || safetyHours > MAX_SAFETY_HOURS) throw new AutoPostingError(`the safety window must be a whole number of hours from 0 to ${MAX_SAFETY_HOURS}`);
  if (!input.channels.every(isNetwork)) throw new AutoPostingError('channels must be a list of instagram, facebook, linkedin, google');
  const channels = [...new Set(input.channels as Network[])].sort();
  const before = readAutoPosting(brandDir);
  const at = now.toISOString();
  const widened = channels.some((c) => !before?.channels.includes(c));
  const next: AutoPosting = { channels, safetyHours, consent: widened || before === null ? { by, at } : before.consent, updatedAt: at };
  const file = join(brandDir, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, file);
  return next;
}

export interface AutoDeps {
  brandsRoot: string;
  owners: ProductBrands;
  now: Date;
  /** Whether a plan file is a customer's own topic request (her own words): those are always hers to confirm and approve, whatever she chose. */
  isTopicPlan?: (brand: string, planFile: string) => boolean;
  /** Called after posters were approved, so they reach the calendar at once. */
  approved?: (brand: string, count: number) => void;
  log?: (message: string) => void;
}

export interface AutoAction {
  brand: string;
  kept: number;
  approved: number;
}

/** The posting moment of every post of a plan file (read once per pass). */
function datesOf(brandDir: string, planFile: string, cache: Map<string, Map<string, number>>): Map<string, number> {
  const name = basename(planFile);
  const known = cache.get(name);
  if (known) return known;
  const dates = new Map<string, number>();
  try {
    const plan = JSON.parse(readFileSync(join(brandDir, name), 'utf8')) as { posts?: Array<{ id?: unknown; date?: unknown }> };
    for (const p of plan.posts ?? []) if (typeof p.id === 'string' && typeof p.date === 'string' && Number.isFinite(Date.parse(p.date))) dates.set(p.id, Date.parse(p.date));
  } catch {
    // no readable plan, no known time: nothing is approved on a guess
  }
  cache.set(name, dates);
  return dates;
}

/** One pass over every product brand that has automatic posting on. Safe to run as often as wanted: each step only does what is still to do. */
export function runAutoPosting(deps: AutoDeps): AutoAction[] {
  const actions: AutoAction[] = [];
  const now = deps.now.getTime();
  for (const brand of deps.owners.all()) {
    const brandDir = join(deps.brandsRoot, brand);
    const setting = readAutoPosting(brandDir);
    if (!isAutomatic(setting) || setting === null) continue;
    let kept = 0;
    let approved = 0;
    try {
      // Keep: a topic the checks gave no warning about, for a day still ahead and a week not yet drawn (a drawn week's topics are final).
      const stage = new CopyStage(brandDir, brand);
      for (const batch of stage.list()) {
        if (batch.closedAt || batch.drawnAt || deps.isTopicPlan?.(brand, batch.planFile) === true) continue;
        for (const post of batch.posts) {
          if (post.state !== 'pending' || post.advice !== undefined || post.date === undefined || Date.parse(`${post.date}T23:59:59+05:30`) <= now) continue;
          const week = weekOfPost(post);
          if (week === undefined || batch.weekDrawn?.[week] !== undefined || batch.weekLapsed?.[week] !== undefined) continue;
          try {
            stage.decide(batch.planFile, post.postId, 'kept', AUTO_POST_BY);
            kept += 1;
          } catch (error) {
            deps.log?.(`auto-posting could not keep ${brand} ${batch.planFile} ${post.postId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      // Approve: a picture that passed the checks, for a channel she chose, once its posting time is inside the safety window and still ahead, for a network that is connected.
      const connected = readConnected(brandDir);
      const store = new ReviewStore(brandDir, brand, () => deps.now);
      const cache = new Map<string, Map<string, number>>();
      for (const item of store.list({ status: 'pending' })) {
        const v = item.version;
        if (v.carousel || deps.isTopicPlan?.(brand, v.planFile) === true || v.network === undefined || !isNetwork(v.network) || !setting.channels.includes(v.network) || connected === null || !connected.has(v.network)) continue;
        const at = datesOf(brandDir, v.planFile, cache).get(v.postId);
        if (at === undefined || at <= now || (setting.safetyHours > 0 && at - setting.safetyHours * HOUR_MS > now)) continue;
        try {
          store.approve(v.versionId, AUTO_POST_BY);
          approved += 1;
        } catch (error) {
          deps.log?.(`auto-posting could not approve ${v.versionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      deps.log?.(`auto-posting of ${brand} failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (approved > 0) deps.approved?.(brand, approved);
    if (kept > 0 || approved > 0) actions.push({ brand, kept, approved });
  }
  return actions;
}
