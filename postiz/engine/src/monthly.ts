/**
 * Runs the autopilot for every client in clients.json, one after another.
 * One client failing does not stop the others; the exit code is non-zero if any failed.
 *
 *   node src/monthly.ts [--clients clients.json]
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { readJson } from './content.ts';

const run = promisify(execFile);
const AUTOPILOT_TIMEOUT_MS = 60 * 60 * 1000;

interface ClientConfig {
  site: string;
  channel: string;
  days: number;
  time: string;
  utcOffset: string;
}

function parseClients(raw: unknown): ClientConfig[] {
  const clients = (raw as { clients?: unknown }).clients;
  if (!Array.isArray(clients) || clients.length === 0) throw new Error('clients.json needs a non-empty "clients" array');
  return clients.map((c: Record<string, unknown>, i) => {
    const required = ['site', 'channel', 'time', 'utcOffset'] as const;
    for (const key of required) {
      if (typeof c[key] !== 'string' || !c[key]) throw new Error(`clients[${i}].${key} must be a non-empty string`);
    }
    if (!Number.isInteger(c['days'])) throw new Error(`clients[${i}].days must be a whole number`);
    return c as unknown as ClientConfig;
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { clients: { type: 'string', default: 'clients.json' } } });
  const clients = parseClients(await readJson(resolve(values.clients)));
  const failed: string[] = [];

  for (const client of clients) {
    console.log(`\n=== ${new Date().toISOString()} ${client.site} → ${client.channel}`);
    try {
      const { stdout } = await run(
        process.execPath,
        [
          'src/autopilot.ts',
          '--site', client.site,
          '--channel', client.channel,
          '--days', String(client.days),
          '--time', client.time,
          '--utc-offset', client.utcOffset,
        ],
        { timeout: AUTOPILOT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      );
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
