/**
 * Running headless Chrome on a poster page: once to measure it (the page's own script writes a report that is read from the
 * dumped DOM) and once to capture the frozen page as a PNG, plus a check that the PNG has the exact size. Each job gets its
 * own temporary directory and profile, a timeout, and cleanup. Chrome's exit code is never taken as success.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { CANVAS_SIZE } from './layout.ts';
import { chromeArgs, chromeDumpArgs, chromePath } from './platform.ts';

const execFileAsync = promisify(execFile);

export type RunFn = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

export interface ChromeDeps {
  run?: RunFn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Milliseconds before a Chrome process is stopped. */
  timeoutMs?: number;
}

const defaultRun: RunFn = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, args, { ...options, encoding: 'utf8' });
  return { stdout };
};

export class ChromeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChromeError';
  }
}

const resolveDeps = (deps: ChromeDeps) => ({
  run: deps.run ?? defaultRun,
  env: deps.env ?? process.env,
  platform: deps.platform ?? process.platform,
  timeout: deps.timeoutMs ?? 90_000,
});

async function withJob<T>(work: (dir: string, profile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'poster-job-'));
  try {
    return await work(dir, join(dir, 'profile'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The Chrome version string, recorded in every render report. */
export async function chromeVersion(deps: ChromeDeps = {}): Promise<string> {
  const { run, env, platform, timeout } = resolveDeps(deps);
  try {
    const { stdout } = await run(chromePath(env, platform), ['--version'], { timeout, maxBuffer: 1 << 20 });
    return stdout.trim();
  } catch (error) {
    throw new ChromeError(`Chrome could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Opens the page in headless Chrome and returns the DOM after its scripts ran. */
export async function measureHtml(html: string, deps: ChromeDeps = {}): Promise<string> {
  const { run, env, platform, timeout } = resolveDeps(deps);
  return withJob(async (dir, profile) => {
    const path = join(dir, 'poster.html');
    await writeFile(path, html);
    const args = [...chromeDumpArgs(profile, pathToFileURL(path).href, env as Record<string, string | undefined>), `--window-size=${CANVAS_SIZE},${CANVAS_SIZE}`];
    try {
      const { stdout } = await run(chromePath(env, platform), args, { timeout, maxBuffer: 32 << 20 });
      return stdout;
    } catch (error) {
      throw new ChromeError(`Chrome failed while measuring: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** The width and height of a PNG, read from its header. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) throw new ChromeError('the capture is not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Captures the page as a PNG at `pngPath` and checks it is exactly the canvas size. */
export async function captureHtml(html: string, pngPath: string, deps: ChromeDeps = {}): Promise<{ width: number; height: number }> {
  const { run, env, platform, timeout } = resolveDeps(deps);
  return withJob(async (dir, profile) => {
    const path = join(dir, 'poster.html');
    await writeFile(path, html);
    const args = chromeArgs(profile, pngPath, pathToFileURL(path).href, CANVAS_SIZE, env as Record<string, string | undefined>);
    try {
      await run(chromePath(env, platform), args, { timeout, maxBuffer: 8 << 20 });
    } catch (error) {
      throw new ChromeError(`Chrome failed while capturing: ${error instanceof Error ? error.message : String(error)}`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(pngPath);
    } catch {
      throw new ChromeError('Chrome exited without writing the capture');
    }
    const size = pngSize(bytes);
    if (size.width !== CANVAS_SIZE || size.height !== CANVAS_SIZE) throw new ChromeError(`the capture is ${size.width}x${size.height}, not ${CANVAS_SIZE}x${CANVAS_SIZE}`);
    return size;
  });
}
