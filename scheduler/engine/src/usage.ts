/**
 * Counts what a run asks of the AI, and what it costs. Tokens are OpenAI's own numbers from each reply. Prices are
 * a settings table here (dollars per million tokens), so they are easy to update; a model that is not listed is
 * shown as unpriced, never guessed. A picture whose reply has no token counts is priced from OpenAI's per-picture table.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ImageQuality } from './ai.ts';

/** Dollars per million tokens. Image models: text prompt in, picture out. */
export const RATES: Readonly<Record<string, { in: number; out: number }>> = {
  'gpt-6-luna': { in: 0.1, out: 0.5 },
  'gpt-6.1-terra': { in: 1, out: 5 },
  'gpt-6.1-sol': { in: 2, out: 10 },
  'gpt-6-astra': { in: 10, out: 50 },
  'gpt-image-2': { in: 5, out: 30 },
  'gpt-image-2.5-flare': { in: 5, out: 30 },
  'gpt-image-2.5-sunburst': { in: 5, out: 30 },
};

/** OpenAI's approximate cost of one 1024x1024 picture (GPT Image 2 family) when the reply has no token counts. */
const FLAT_IMAGE_COST: Readonly<Record<ImageQuality, number>> = { low: 0.006, medium: 0.053, high: 0.211 };
export const flatImageCost = (quality: ImageQuality): number => FLAT_IMAGE_COST[quality];

const round = (dollars: number): number => Math.round(dollars * 1e8) / 1e8;

export interface UsageEntry {
  kind: 'text' | 'image';
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** A price for the whole call, when only an estimate from a table is known. */
  flatCost?: number;
}

/** Dollars for one call, or null when the model has no known price. */
export function costOf(entry: UsageEntry): number | null {
  if (entry.flatCost !== undefined) return entry.flatCost;
  const rate = RATES[entry.model];
  return rate ? round((entry.inputTokens * rate.in + entry.outputTokens * rate.out) / 1_000_000) : null;
}

export interface UsageLine {
  kind: UsageEntry['kind'];
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** Some or all of the cost comes from a per-picture table, not from token counts. */
  estimated: boolean;
}

/** What a call was for: a poster's picture, the week's post writing, or reading the client's website. */
export type Purpose = 'picture' | 'writing' | 'profile';

/** One line of the usage log: a single AI call (or a post's share of one), with the client and post it belongs to. */
export interface UsageRecord {
  at: string;
  client: string;
  /** The post it was made for; null for the website reading, which belongs to the client. */
  post: string | null;
  purpose: Purpose;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Dollars, or null when the model has no known price. */
  costUsd: number | null;
  estimated: boolean;
}

interface Call {
  entry: UsageEntry;
  purpose: Purpose;
  post: string | null;
}

export class UsageTally {
  private readonly lines = new Map<string, UsageLine>();
  private readonly calls: Call[] = [];
  /** What the next text calls are for. Pictures are always pictures. */
  purpose: Purpose = 'writing';
  /** The post the next calls are for, if any. */
  post: string | null = null;

  /** The calls so far as log records. Writing that was not made for one post is shared evenly across `postIds`. */
  records(client: string, postIds: readonly string[], when: Date = new Date()): UsageRecord[] {
    const at = when.toISOString();
    return this.calls.flatMap(({ entry, purpose, post }): UsageRecord[] => {
      const cost = costOf(entry);
      const base = { at, client, purpose, model: entry.model, estimated: entry.flatCost !== undefined };
      if (purpose !== 'writing' || post !== null || postIds.length === 0) {
        return [{ ...base, post, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, costUsd: cost }];
      }
      const share = (value: number): number => Math.round(value / postIds.length);
      return postIds.map((id) => ({ ...base, post: id, inputTokens: share(entry.inputTokens), outputTokens: share(entry.outputTokens), costUsd: cost === null ? null : round(cost / postIds.length) }));
    });
  }

  add(entry: UsageEntry): void {
    this.calls.push({ entry, purpose: entry.kind === 'image' ? 'picture' : this.purpose, post: this.post });
    const key = `${entry.kind}|${entry.model}`;
    const line = this.lines.get(key) ?? { kind: entry.kind, model: entry.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false };
    const cost = costOf(entry);
    line.calls += 1;
    line.inputTokens += entry.inputTokens;
    line.outputTokens += entry.outputTokens;
    line.costUsd = cost === null || line.costUsd === null ? null : round(line.costUsd + cost);
    if (entry.flatCost !== undefined) line.estimated = true;
    this.lines.set(key, line);
  }

  summary(): { lines: UsageLine[]; totalUsd: number; hasUnknown: boolean } {
    const lines = [...this.lines.values()];
    return {
      lines,
      totalUsd: round(lines.reduce((sum, line) => sum + (line.costUsd ?? 0), 0)),
      hasUnknown: lines.some((line) => line.costUsd === null),
    };
  }

  /** A short report for the end of a run. */
  format(): string {
    const { lines, totalUsd, hasUnknown } = this.summary();
    if (lines.length === 0) return 'AI usage: nothing was asked of the AI.';
    const money = (value: number | null): string => (value === null ? 'unpriced' : `$${value.toFixed(4)}`);
    const rows = lines.map((l) => {
      const tokens = l.estimated && l.kind === 'image' ? '(priced per picture)' : `${l.inputTokens.toLocaleString('en-US')} in / ${l.outputTokens.toLocaleString('en-US')} out tokens`;
      return `  ${l.kind.padEnd(5)} ${l.model.padEnd(24)} ${String(l.calls).padStart(3)} calls   ${tokens.padEnd(34)} ${money(l.costUsd)}`;
    });
    return ['AI usage this run (estimates from OpenAI\'s token counts and published prices):', ...rows, `  Total  $${totalUsd.toFixed(4)}${hasUnknown ? '  (some calls could not be priced)' : ''}`].join('\n');
  }
}

/** Adds the records to the usage log, one JSON object per line. The folder is created if needed. */
export async function appendUsageLog(file: string, records: readonly UsageRecord[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
}
