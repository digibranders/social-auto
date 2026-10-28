/**
 * Runs the autopilot for every client in clients.json, one after another.
 * One client failing does not stop the others; the exit code is non-zero if any failed.
 *
 *   node src/run-clients.ts [--clients clients.json]
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { readJson } from './content.ts';

const run = promisify(execFile);
const AUTOPILOT_TIMEOUT_MS = 60 * 60 * 1000;

export type ClientTarget = 'scheduler' | 'publisher';

export interface ClientConfig {
  site: string;
  /** Instagram username; required for the "scheduler" target. */
  channel?: string;
  days: number;
  time: string;
  utcOffset: string;
  target: ClientTarget;
}

export function parseClients(raw: unknown): ClientConfig[] {
  const clients = (raw as { clients?: unknown }).clients;
  if (!Array.isArray(clients) || clients.length === 0) throw new Error('clients.json needs a non-empty "clients" array');
  return clients.map((c: Record<string, unknown>, i) => {
    for (const key of ['site', 'time', 'utcOffset'] as const) {
      if (typeof c[key] !== 'string' || !c[key]) throw new Error(`clients[${i}].${key} must be a non-empty string`);
    }
    if (!Number.isInteger(c['days'])) throw new Error(`clients[${i}].days must be a whole number`);
    const target = c['target'] ?? 'scheduler';
    if (target !== 'scheduler' && target !== 'publisher') {
      throw new Error(`clients[${i}].target must be "scheduler" or "publisher"`);
    }
    if (target === 'scheduler' && (typeof c['channel'] !== 'string' || !c['channel'])) {
      throw new Error(`clients[${i}].channel is required for the scheduler target`);
    }
    return { ...(c as unknown as ClientConfig), target };
  });
}

export function autopilotArgs(client: ClientConfig): string[] {
  const args = [
    'src/autopilot.ts',
    '--site', client.site,
    '--days', String(client.days),
    '--time', client.time,
    '--utc-offset', client.utcOffset,
    '--target', client.target,
  ];
  if (client.channel) args.push('--channel', client.channel);
  return args;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { clients: { type: 'string', default: 'clients.json' } } });
  const clients = parseClients(await readJson(resolve(values.clients)));
  const failed: string[] = [];

  for (const client of clients) {
    console.log(`\n=== ${new Date().toISOString()} ${client.site} → ${client.target}`);
    try {
      const { stdout } = await run(process.execPath, autopilotArgs(client), {
        timeout: AUTOPILOT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      console.log(stdout.trim());
    } catch (error) {
      failed.push(client.site);
      const details = error as { stdout?: string; stderr?: string; message?: string };
      console.error(`FAILED ${client.site}: ${details.stderr?.trim() || details.message}`);
      if (details.stdout) console.error(details.stdout.trim());
    }
  }

  if (failed.length) {
    console.error(`\n${failed.length} of ${clients.length} clients failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${clients.length} clients done.`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
