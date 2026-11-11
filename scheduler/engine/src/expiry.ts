/**
 * Nobody decided in time. For a brand a product owns, written posts that were never drawn and pictures that are still waiting are put away after a number
 * of days, with no one acting: a batch is closed, a waiting picture is rejected with the reason "expired". Our own brands are never touched.
 * Each thing put away is recorded in one small log, so the product can tell its customer.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CopyStage } from './copy-stage.ts';
import type { ProductBrands } from './product-brands.ts';
import { EXPIRED_REASON, ReviewStore } from './review-store.ts';

export const EXPIRY_BY = 'system:expiry';
export const EXPIRY_DAYS = 14;
const DAY_MS = 86_400_000;

export interface ExpiryEvent {
  at: string;
  brand: string;
  kind: 'batch' | 'poster';
  planFile: string;
  postId?: string;
  network?: string;
  versionId?: string;
}

const logFile = (brandsRoot: string): string => join(brandsRoot, '.expiry.jsonl');

/** What was put away, oldest first; a product reads only its own brand and may ask for what came after a time it already saw. */
export function readExpiry(brandsRoot: string, filter: { brand?: string; since?: string } = {}): ExpiryEvent[] {
  const file = logFile(brandsRoot);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ExpiryEvent)
    .filter((e) => (filter.brand === undefined || e.brand === filter.brand) && (filter.since === undefined || e.at > filter.since));
}

/** Puts away what is older than `days` for every product-owned brand. A thing that cannot be changed right now (busy) is left for the next pass. */
export function sweepExpired(input: { brandsRoot: string; owners: ProductBrands; now: Date; days?: number; lockTimeoutMs?: number }): ExpiryEvent[] {
  const cutoff = input.now.getTime() - (input.days ?? EXPIRY_DAYS) * DAY_MS;
  const stale = (iso: string): boolean => Date.parse(iso) <= cutoff;
  const events: ExpiryEvent[] = [];
  const record = (event: Omit<ExpiryEvent, 'at'>): void => {
    const full: ExpiryEvent = { at: input.now.toISOString(), ...event };
    appendFileSync(logFile(input.brandsRoot), `${JSON.stringify(full)}\n`);
    events.push(full);
  };
  for (const brand of input.owners.all()) {
    const dir = join(input.brandsRoot, brand);
    if (!existsSync(dir)) continue;
    const stage = new CopyStage(dir, brand);
    for (const batch of stage.list()) {
      if (batch.closedAt || batch.drawnAt || !stale(batch.createdAt)) continue;
      try {
        stage.close(batch.planFile, EXPIRY_BY);
        record({ brand, kind: 'batch', planFile: batch.planFile });
      } catch (error) {
        console.error(`expiry: could not close ${brand}/${batch.planFile}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const store = new ReviewStore(dir, brand, undefined, input.lockTimeoutMs);
    for (const item of store.list()) {
      if (item.status !== 'pending' || !stale(item.version.createdAt)) continue;
      try {
        store.reject(item.version.versionId, EXPIRY_BY, EXPIRED_REASON);
        record({ brand, kind: 'poster', planFile: item.version.planFile, postId: item.version.postId, versionId: item.version.versionId, ...(item.version.network ? { network: item.version.network } : {}) });
      } catch (error) {
        console.error(`expiry: could not expire ${item.version.versionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return events;
}
