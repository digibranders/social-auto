import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What differs between the Mac the engine was written on and the Linux server it can also run on:
 * where Chrome is, which tool turns a screenshot into a JPG, and where the keys file lives.
 */

type Env = Record<string, string | undefined>;

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** CHROME_PATH wins; otherwise the usual place for the operating system (Linux finds it on PATH). */
export function chromePath(env: Env, platform: NodeJS.Platform): string {
  if (env['CHROME_PATH']) return env['CHROME_PATH'];
  return platform === 'darwin' ? MAC_CHROME : 'google-chrome';
}

/**
 * The headless screenshot arguments. Ubuntu can refuse Chrome's sandbox for a normal user; the server sets
 * CHROME_NO_SANDBOX=1 there. The engine only ever opens pages it built itself.
 */
export function chromeArgs(profileDir: string, pngPath: string, pageUrl: string, size: number, env: Env): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    ...(env['CHROME_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profileDir}`,
    `--window-size=${size},${size}`,
    '--virtual-time-budget=8000',
    `--screenshot=${pngPath}`,
    pageUrl,
  ];
}

/** Chrome's arguments for printing a page as it looks after its scripts ran (used to read sites that build themselves in the browser). */
export function chromeDumpArgs(profileDir: string, pageUrl: string, env: Env): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    ...(env['CHROME_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : []),
    `--user-data-dir=${profileDir}`,
    '--virtual-time-budget=8000',
    '--dump-dom',
    pageUrl,
  ];
}

/** macOS has sips; elsewhere ImageMagick's `convert` does the same job. */
export function jpegCommand(platform: NodeJS.Platform, pngPath: string, jpgPath: string, quality: number): { file: string; args: string[] } {
  if (platform === 'darwin') {
    return { file: 'sips', args: ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), pngPath, '--out', jpgPath] };
  }
  return { file: 'convert', args: [pngPath, '-quality', String(quality), jpgPath] };
}

const DEFAULT_ENV_FILE = fileURLToPath(new URL('../../upstream/.env', import.meta.url));

/** The keys file: the --env flag, else SOCIAL_AUTO_ENV, else the file the Mac setup has always used. */
export function envFilePath(flag: string | undefined, env: Env): string {
  return resolve(flag ?? (env['SOCIAL_AUTO_ENV'] || DEFAULT_ENV_FILE));
}

/**
 * Loads a keys file if there is one. Values already in the environment win, so a server can supply them
 * another way. Returns whether a file was read; callers still check that the keys they need are present.
 */
export function loadEnvIfPresent(path: string): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
