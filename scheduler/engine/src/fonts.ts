/**
 * Local fonts for posters. Production renders must not fetch fonts from the network: a font is a file in a fonts directory,
 * listed in `manifest.json` with its weight, the scripts it covers and the SHA-256 of the file, and verified before use. A
 * brand whose font is not in the manifest falls back to the system stack, and the render report says so. Licensing is a
 * human check before a file is added to the directory; this module only guarantees that what is used is what was approved.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scriptOf, systemFont, type ResolvedFont, type Script } from './typography.ts';

export class FontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontError';
  }
}

export interface FontFile {
  family: string;
  weight: number;
  style?: 'normal' | 'italic';
  /** Path inside the fonts directory. */
  file: string;
  sha256: string;
  scripts: Script[];
}

export interface FontManifest {
  /** The directory the files were verified in. */
  dir: string;
  fonts: FontFile[];
}

const SCRIPTS: readonly Script[] = ['latin', 'devanagari', 'arabic', 'hebrew', 'cjk', 'other'];

function parseManifest(raw: unknown): FontFile[] {
  const fonts = (raw as { fonts?: unknown } | null)?.fonts;
  if (!Array.isArray(fonts)) throw new FontError('font manifest: "fonts" must be an array');
  return fonts.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const where = `font manifest entry ${i + 1}`;
    if (typeof e['family'] !== 'string' || !e['family'].trim()) throw new FontError(`${where}: "family" must be text`);
    if (typeof e['weight'] !== 'number' || !Number.isInteger(e['weight']) || e['weight'] < 100 || e['weight'] > 900) throw new FontError(`${where}: "weight" must be 100-900`);
    if (typeof e['file'] !== 'string' || !e['file'].trim()) throw new FontError(`${where}: "file" must be text`);
    if (typeof e['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(e['sha256'])) throw new FontError(`${where}: "sha256" must be 64 hex characters`);
    if (!Array.isArray(e['scripts']) || e['scripts'].length === 0 || !e['scripts'].every((s) => SCRIPTS.includes(s as Script))) throw new FontError(`${where}: "scripts" must list scripts from ${SCRIPTS.join(', ')}`);
    const style = e['style'] === 'italic' ? 'italic' : 'normal';
    return { family: e['family'].trim(), weight: e['weight'], style, file: e['file'], sha256: e['sha256'], scripts: e['scripts'] as Script[] } satisfies FontFile;
  });
}

/** Reads and verifies a fonts directory. Returns undefined when it has no manifest; throws when a listed file is missing, outside the directory or does not match its hash. */
export async function loadFontManifest(dir: string): Promise<FontManifest | undefined> {
  const root = resolve(dir);
  let text: string;
  try {
    text = await readFile(join(root, 'manifest.json'), 'utf8');
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FontError('font manifest is not valid JSON');
  }
  const fonts = parseManifest(raw);
  for (const font of fonts) {
    const path = resolve(root, font.file);
    const inside = relative(root, path);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new FontError(`font file "${font.file}" is outside the fonts directory`);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new FontError(`font file "${font.file}" listed in the manifest is missing`);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== font.sha256) throw new FontError(`font file "${font.file}" does not match its recorded hash`);
  }
  return { dir: root, fonts };
}

const familyKey = (name: string): string => name.trim().toLowerCase();

/** The brand's font: from the verified local files when the manifest has its family, else the system stack. */
export function resolveFont(name: string, manifest?: FontManifest): ResolvedFont {
  const files = manifest?.fonts.filter((f) => familyKey(f.family) === familyKey(name)) ?? [];
  if (!manifest || files.length === 0) return systemFont(name);
  const family = files[0]?.family.replace(/["'\\<>{};]/g, '') ?? name;
  const css = files
    .map((f) => `@font-face{font-family:"${family}";font-weight:${f.weight};font-style:${f.style ?? 'normal'};src:url("${pathToFileURL(resolve(manifest.dir, f.file)).href}");}`)
    .join('\n');
  return { css, stack: `"${family}", ${systemFont('').stack}`, source: 'local', faces: [family] };
}

export type Coverage = 'verified' | 'unverified';

/** Whether the text's script is one the brand's local font declares. System fonts are never verified: the render report checks for missing glyphs instead. */
export function fontCoverage(name: string, text: string, manifest?: FontManifest): Coverage {
  const files = manifest?.fonts.filter((f) => familyKey(f.family) === familyKey(name)) ?? [];
  if (files.length === 0) return 'unverified';
  const script = scriptOf(text);
  return files.some((f) => f.scripts.includes(script)) ? 'verified' : 'unverified';
}
