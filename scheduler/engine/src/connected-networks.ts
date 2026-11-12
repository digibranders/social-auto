/**
 * Which networks a product's customer has connected accounts for, kept beside the brand's files. The product API writes it whenever it looks at the customer's
 * channels; the draw reads it so no picture is bought for a network that has no account to send it to. When it has never been written, every network the
 * posts were written for is drawn (as before).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isNetwork, type Network } from './networks.ts';

const FILE = 'connected.json';

/** The connected networks of a brand, or null when none were ever recorded. */
export function readConnected(brandDir: string): ReadonlySet<Network> | null {
  const file = join(brandDir, FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { networks?: unknown };
    return Array.isArray(parsed.networks) ? new Set(parsed.networks.filter(isNetwork)) : null;
  } catch {
    return null;
  }
}

/** Records the connected networks. Anything that is not one of the four networks is ignored. Writes only when it changed. */
export function writeConnected(brandDir: string, networks: readonly unknown[], now: Date = new Date()): { changed: boolean } {
  const wanted = [...new Set(networks.filter(isNetwork))].sort();
  const before = readConnected(brandDir);
  if (before && before.size === wanted.length && wanted.every((n) => before.has(n))) return { changed: false };
  const file = join(brandDir, FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ networks: wanted, updatedAt: now.toISOString() })}\n`);
  renameSync(temp, file);
  return { changed: true };
}
