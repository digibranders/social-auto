import { readFile } from 'node:fs/promises';

/**
 * What the content engine spent on AI, read from its usage log (one JSON object per line, written by
 * scheduler/engine/src/usage.ts). Costs are dollars, estimated from OpenAI's token counts.
 */
export type CostPurpose = 'picture' | 'writing' | 'profile';

const PURPOSES: readonly CostPurpose[] = ['picture', 'writing', 'profile'];

export interface UsageRecord {
  at: string;
  client: string;
  post: string | null;
  purpose: CostPurpose;
  costUsd: number | null;
}

/** One client's spend on one thing (a post's picture, a post's writing, or the website reading), added up. */
export interface CostEntry {
  brand: string;
  post: string | null;
  purpose: CostPurpose;
  /** When the latest of these calls was made. */
  at: string;
  usd: number;
}

const round = (dollars: number): number => Math.round(dollars * 1e8) / 1e8;

function parseRecord(line: string): UsageRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const { at, client, post, purpose, costUsd } = o;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || typeof client !== 'string' || client === '') return null;
  if (post !== null && typeof post !== 'string') return null;
  if (typeof purpose !== 'string' || !PURPOSES.includes(purpose as CostPurpose)) return null;
  if (costUsd !== null && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) return null;
  return { at, client, post, purpose: purpose as CostPurpose, costUsd };
}

export function parseUsageLog(text: string): { records: UsageRecord[]; skipped: number } {
  const records: UsageRecord[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const record = parseRecord(line);
    if (record) records.push(record);
    else skipped += 1;
  }
  return { records, skipped };
}

/** Adds records per client, post and purpose. A call with no known price adds nothing. */
export function summarizeUsage(records: readonly UsageRecord[]): CostEntry[] {
  const entries = new Map<string, CostEntry>();
  for (const r of records) {
    const key = JSON.stringify([r.client, r.post, r.purpose]);
    const existing = entries.get(key);
    const usd = r.costUsd ?? 0;
    if (!existing) entries.set(key, { brand: r.client, post: r.post, purpose: r.purpose, at: r.at, usd: round(usd) });
    else {
      existing.usd = round(existing.usd + usd);
      if (Date.parse(r.at) > Date.parse(existing.at)) existing.at = r.at;
    }
  }
  return [...entries.values()];
}

/** The summarized log, or nothing when no log file is set or none has been written yet. A damaged line is reported, not fatal. */
export async function loadCosts(file: string | undefined, onProblem: (message: string) => void = (m) => console.error(m)): Promise<CostEntry[]> {
  if (!file) return [];
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const { records, skipped } = parseUsageLog(text);
  if (skipped > 0) onProblem(`usage log ${file}: skipped ${skipped} unreadable line${skipped === 1 ? '' : 's'}`);
  return summarizeUsage(records);
}
