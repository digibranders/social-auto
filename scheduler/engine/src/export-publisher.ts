/**
 * Copies rendered posters and captions into the Vercel publisher so it can post without this Mac.
 * Only posts that are still upcoming (or due today) are exported.
 *
 * Posters are public (Instagram downloads them) but named by a hash of their content, so URLs
 * cannot be guessed. The schedule is written to publisher/data/, which is bundled into the
 * posting function and never served as a public file.
 *
 *   node src/export-publisher.ts --brand brands/brandbasket [--publisher ../../publisher]
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { composeCaption, parseWeekPlan, readJson } from './content.ts';

const WEEK_FILE = /^week-\d+\.json$/;
/** Keep posts from the last 20 hours so a post due today is still published. */
const KEEP_RECENT_MS = 20 * 60 * 60 * 1000;

export interface ExportedPost {
  brand: string;
  id: string;
  date: string;
  caption: string;
  image: string;
}

/** 128-bit content hash: stable for the same image, unguessable without it. */
export function posterFileName(image: Buffer): string {
  return `${createHash('sha256').update(image).digest('hex').slice(0, 32)}.jpg`;
}

const SCHEDULE_FILE = join('data', 'schedule.json');

async function readSchedule(path: string): Promise<ExportedPost[]> {
  try {
    return (JSON.parse(await readFile(path, 'utf8')) as { posts: ExportedPost[] }).posts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function exportToPublisher(brandDir: string, publisherDir: string, now = Date.now()): Promise<ExportedPost[]> {
  const brand = basename(brandDir);
  const postsDir = join(publisherDir, 'public', 'posts', brand);
  await rm(postsDir, { recursive: true, force: true });
  await mkdir(postsDir, { recursive: true });
  await mkdir(join(publisherDir, 'data'), { recursive: true });

  const exported: ExportedPost[] = [];
  const files = (await readdir(brandDir)).filter((f) => WEEK_FILE.test(f)).sort();
  for (const file of files) {
    const plan = parseWeekPlan(await readJson(join(brandDir, file)), file);
    const outDir = resolve('out', brand, basename(file, '.json'));
    for (const post of plan.posts) {
      if (Date.parse(post.date) < now - KEEP_RECENT_MS) continue;
      const image = await readFile(join(outDir, `${post.id}.jpg`));
      const fileName = posterFileName(image);
      await writeFile(join(postsDir, fileName), image);
      exported.push({
        brand,
        id: `${brand}-${post.id}`,
        date: post.date,
        caption: composeCaption(post),
        image: `/posts/${brand}/${fileName}`,
      });
    }
  }

  // The schedule is shared by all brands: replace only this brand's entries.
  const schedulePath = join(publisherDir, SCHEDULE_FILE);
  const others = (await readSchedule(schedulePath)).filter((p) => p.brand !== brand);
  const merged = [...others, ...exported].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  await writeFile(schedulePath, `${JSON.stringify({ posts: merged }, null, 2)}\n`);
  await rm(join(publisherDir, 'public', 'schedule.json'), { force: true });
  return exported;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      brand: { type: 'string' },
      publisher: { type: 'string', default: '../../publisher' },
    },
  });
  if (!values.brand) throw new Error('Usage: --brand <dir> [--publisher <dir>]');
  const posts = await exportToPublisher(resolve(values.brand), resolve(values.publisher));
  const first = posts[0]?.date ?? '-';
  const last = posts.at(-1)?.date ?? '-';
  console.log(`Exported ${posts.length} posts (${first} → ${last})`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
