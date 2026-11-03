import { readFileSync, statSync } from 'node:fs';
import { schedule as bundled } from '../data/schedule.js';

/**
 * Where the posting code gets its schedule. On Vercel the generated file is compiled into the deployment. On the
 * server (SCHEDULE_FILE set) the weekly job rewrites the file in place, so the latest version is read from disk
 * whenever it changes: no redeploy and no restart.
 */
export interface ScheduleSource {
  /** The latest schedule: `{ posts: [...] }`. */
  current(): unknown;
  /** The same, shaped so it can be passed where the old static import was (parseSchedule only reads `.posts`). */
  readonly data: { readonly posts: unknown };
}

/** Reads `export const schedule = { ... };` as written by scheduler/engine/src/export-publisher.ts (plain JSON). */
export function parseScheduleModule(text: string): { posts: unknown } {
  const marker = /export const schedule\s*=\s*/.exec(text);
  const end = text.lastIndexOf('}');
  if (!marker || end < marker.index) throw new Error('the schedule file is not the generated "export const schedule = {...}" module');
  try {
    return JSON.parse(text.slice(marker.index + marker[0].length, end + 1)) as { posts: unknown };
  } catch {
    throw new Error('the schedule file is not the generated "export const schedule = {...}" module');
  }
}

export function createScheduleSource(
  file: string | undefined,
  fallback: unknown,
  onRead?: () => void,
  onProblem: (message: string) => void = (m) => console.error(m),
): ScheduleSource {
  let cached: { mtimeMs: number; value: unknown } | null = null;
  const current = (): unknown => {
    if (!file) return fallback;
    try {
      const { mtimeMs } = statSync(file);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        onRead?.();
        cached = { mtimeMs, value: parseScheduleModule(readFileSync(file, 'utf8')) };
      }
    } catch (error) {
      // A half-written or broken new version must not take posting down: keep the last good one.
      if (!cached) throw new Error(`cannot read the schedule from ${file}: ${error instanceof Error ? error.message : String(error)}`);
      onProblem(`schedule file unreadable, keeping the previous version: ${error instanceof Error ? error.message : String(error)}`);
    }
    return cached.value;
  };
  return {
    current,
    get data() {
      return current() as { posts: unknown };
    },
  };
}

export const scheduleSource = createScheduleSource(process.env['SCHEDULE_FILE'], bundled);

/** Drop-in for the old `import { schedule } from '../data/schedule.js'`. */
export const scheduleData = scheduleSource.data;
