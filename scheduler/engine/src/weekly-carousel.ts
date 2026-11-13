/**
 * The weekly carousel of a product's customer who switched it on. Like the weekly draw it is made by the system on the Thursday before the week, at 10:00 India time,
 * for the Friday of that week, so it waits for the customer's approval before it can go out; nothing is ever approved here. It is made only when the customer is set up
 * (the connected channels are known, her website was read and she has a written batch), the week has no carousel that is still wanted (carousel-limit.ts), and it was
 * not already asked for: a try that failed is left for the customer to decide, never repeated by the system.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { carouselRoom, type CarouselMade } from './carousel-limit.ts';
import { readConnected } from './connected-networks.ts';
import { CopyStage } from './copy-stage.ts';
import type { JobStore } from './job-store.ts';
import type { ProductBrands } from './product-brands.ts';
import { drawDueMs, weekEndMs } from './weekly-draw.ts';

export const WEEKLY_CAROUSEL_BY = 'system:weekly-carousel';
const FILE = 'carousel-weekly.json';
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 3_600_000;

/** Whether the customer switched the weekly carousel on. */
export function readCarouselWeekly(brandDir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(brandDir, FILE), 'utf8')) as { enabled?: unknown };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

/** Switches it on or off. Writes only when it changed. */
export function writeCarouselWeekly(brandDir: string, enabled: boolean, now: Date = new Date()): { changed: boolean } {
  if (readCarouselWeekly(brandDir) === enabled && (enabled || existsSync(join(brandDir, FILE)))) return { changed: false };
  const file = join(brandDir, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ enabled, updatedAt: now.toISOString() })}\n`);
  renameSync(temp, file);
  return { changed: true };
}

export interface WeeklyCarouselDeps {
  brandsRoot: string;
  jobs: JobStore;
  owners: ProductBrands;
  now: Date;
  /** The carousels already made for the brand, with whether the customer rejected each. */
  made: (brand: string) => CarouselMade[];
  siteOf: (brand: string) => string | null;
}

export interface WeeklyCarouselAction {
  brand: string;
  /** The Monday of the week it is made for. */
  week: string;
  /** The day it is for (the Friday). */
  date: string;
}

const mondayOfMs = (ms: number): number => {
  const india = new Date(ms + IST_OFFSET_MS);
  const sinceMonday = (india.getUTCDay() + 6) % 7;
  return Date.UTC(india.getUTCFullYear(), india.getUTCMonth(), india.getUTCDate() - sinceMonday);
};
const dayOf = (utcMidnightMs: number): string => new Date(utcMidnightMs).toISOString().slice(0, 10);

/** One pass over every product-owned brand. Safe to run as often as wanted: a week is only ever asked for once. */
export function runWeeklyCarousels(deps: WeeklyCarouselDeps): WeeklyCarouselAction[] {
  const actions: WeeklyCarouselAction[] = [];
  const now = deps.now.getTime();
  const thisMonday = mondayOfMs(now);
  for (const brand of deps.owners.all()) {
    const brandDir = join(deps.brandsRoot, brand);
    try {
      if (!readCarouselWeekly(brandDir)) continue;
      const connected = readConnected(brandDir);
      if (connected === null || connected.size === 0) continue;
      if (!existsSync(join(brandDir, 'brand.json')) || new CopyStage(brandDir, brand).list().length === 0) continue;
      const site = deps.siteOf(brand);
      if (site === null) continue;
      // This week (when the Thursday before it passed and its Friday has not) and the next one (from its own Thursday).
      for (const mondayMs of [thisMonday, thisMonday + 7 * DAY_MS]) {
        const monday = dayOf(mondayMs);
        const friday = dayOf(mondayMs + 4 * DAY_MS);
        const dueAt = drawDueMs(monday);
        const fridayAt = Date.parse(`${friday}T10:00:00+05:30`);
        if (now < dueAt || now >= weekEndMs(monday) || now >= fridayAt) continue;
        // Asked for already, by the system or by her, for this week: a carousel that failed is hers to decide on.
        const asked = deps.jobs.list({ brand }).some((j) => j.kind === 'carousel' && typeof j.startDate === 'string' && j.startDate >= monday && j.startDate <= dayOf(mondayMs + 6 * DAY_MS));
        if (asked) continue;
        if (!carouselRoom(deps.made(brand), `${friday}T10:00:00+05:30`).ok) continue;
        // A carousel job already running for her is the only one allowed at a time: this week is tried again on the next pass.
        const { created } = deps.jobs.enqueue({ kind: 'carousel', brand, site, by: WEEKLY_CAROUSEL_BY, networks: [...connected], startDate: friday, time: '10:00', auto: true });
        if (created) actions.push({ brand, week: monday, date: friday });
        break;
      }
    } catch (error) {
      console.error(`weekly carousel of ${brand} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return actions;
}
