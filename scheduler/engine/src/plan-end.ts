/**
 * The end of a product's customer's paid period, kept beside the brand's files. The product API writes it whenever the product says "stop from this billing date"
 * (and clears it when she keeps or renews the plan). From 00:00 India time on that date nothing new is written, drawn or paid for her: the review service refuses
 * new jobs, the weekly timers skip her, and a job already waiting is not started. What was made before stays as it is.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'billing-end.json';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isRealDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/** The billing date (YYYY-MM-DD) recorded for a brand, or null when none is set (or the file is damaged: nothing is ever blocked on a guess). */
export function readPlanEnd(brandDir: string): string | null {
  const file = join(brandDir, FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { endDate?: unknown };
    return isRealDay(parsed.endDate) ? parsed.endDate : null;
  } catch {
    return null;
  }
}

/** Records the billing date, or clears it (null). Writes only when it changed. */
export function writePlanEnd(brandDir: string, endDate: string | null, now: Date = new Date()): { changed: boolean } {
  if (endDate !== null && !isRealDay(endDate)) throw new Error('the billing date must be a real day, YYYY-MM-DD');
  if (readPlanEnd(brandDir) === endDate) return { changed: false };
  const file = join(brandDir, FILE);
  if (endDate === null) {
    if (existsSync(file)) unlinkSync(file);
    return { changed: true };
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ endDate, updatedAt: now.toISOString() })}\n`);
  renameSync(temp, file);
  return { changed: true };
}

/** Whether the paid period has ended at this moment: it is 00:00 India time on the billing date or later. */
export function planEnded(brandDir: string, nowMs: number): boolean {
  const endDate = readPlanEnd(brandDir);
  return endDate !== null && nowMs >= Date.parse(`${endDate}T00:00:00+05:30`);
}
