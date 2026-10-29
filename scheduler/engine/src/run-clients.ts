/**
 * Runs the autopilot for every client in clients.json, one after another.
 * One client failing does not stop the others; the exit code is non-zero if any failed.
 *
 *   node src/run-clients.ts [--clients clients.json]
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { parseWeekdays, weekdaysForPostsPerWeek, type Weekday } from './cadence.ts';
import { readJson } from './content.ts';

const run = promisify(execFile);
const AUTOPILOT_TIMEOUT_MS = 60 * 60 * 1000;

export type ClientTarget = 'scheduler' | 'publisher';

export interface ClientConfig {
  site: string;
  /** Instagram username; required for the "scheduler" target. */
  channel?: string;
  /**
   * How often to post. Give one of (first match wins):
   *   weekdays      exact days, e.g. ["tue", "sat"]
   *   postsPerWeek  1 to 7, spread evenly through the week (5 = Monday to Friday)
   *   days          older setting: that many posts on consecutive days
   */
  weekdays?: Weekday[];
  postsPerWeek?: number;
  days?: number;
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
    if (c['weekdays'] === undefined && c['postsPerWeek'] === undefined && !Number.isInteger(c['days'])) {
      throw new Error(`clients[${i}] needs "postsPerWeek", "weekdays" or "days"`);
    }
    if (c['postsPerWeek'] !== undefined && (!Number.isInteger(c['postsPerWeek']) || (c['postsPerWeek'] as number) < 1 || (c['postsPerWeek'] as number) > 7)) {
      throw new Error(`clients[${i}].postsPerWeek must be a whole number from 1 to 7`);
    }
    const weekdays = c['weekdays'] === undefined ? undefined : parseWeekdays(c['weekdays']);
    const target = c['target'] ?? 'scheduler';
    if (target !== 'scheduler' && target !== 'publisher') {
      throw new Error(`clients[${i}].target must be "scheduler" or "publisher"`);
    }
    if (target === 'scheduler' && (typeof c['channel'] !== 'string' || !c['channel'])) {
      throw new Error(`clients[${i}].channel is required for the scheduler target`);
    }
    return { ...(c as unknown as ClientConfig), ...(weekdays ? { weekdays } : {}), target };
  });
}

/** The days a client posts on, and how many posts one weekly run adds (a week's worth). */
export function cadenceOf(client: ClientConfig): { count: number; weekdays?: readonly Weekday[] } {
  if (client.weekdays) return { count: client.weekdays.length, weekdays: client.weekdays };
  if (client.postsPerWeek !== undefined) {
    const weekdays = weekdaysForPostsPerWeek(client.postsPerWeek);
    return { count: weekdays.length, weekdays };
  }
  return { count: client.days as number };
}

export function autopilotArgs(client: ClientConfig): string[] {
  const { count, weekdays } = cadenceOf(client);
  const args = [
    'src/autopilot.ts',
    '--site', client.site,
    '--days', String(count),
    '--time', client.time,
    '--utc-offset', client.utcOffset,
    '--target', client.target,
  ];
  if (weekdays) args.push('--weekdays', weekdays.join(','));
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
