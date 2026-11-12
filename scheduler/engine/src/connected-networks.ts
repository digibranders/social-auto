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

/** Thrown when a product's customer is drawn for before the poster service was told which networks she has connected: nothing is bought blind. */
export class ConnectedUnknownError extends Error {
  constructor() {
    super('the poster service has not been told which networks are connected for this customer, so no picture was bought (it is told when she looks at her written posts or asks for pictures)');
    this.name = 'ConnectedUnknownError';
  }
}

/**
 * The connected networks a draw must go by. A product's customer must have them recorded: without them a picture could be bought for a network that has no account,
 * so the draw stops (the product API tells us before every draw). A client of ours has no record and draws for every network its posts were written for.
 */
export function connectedForDraw(brandDir: string, productOwned: boolean): ReadonlySet<Network> | null {
  const connected = readConnected(brandDir);
  if (connected === null && productOwned) throw new ConnectedUnknownError();
  return connected;
}
