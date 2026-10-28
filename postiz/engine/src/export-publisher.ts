/**
 * Copies rendered posters and captions into the Vercel publisher so it can post without this Mac.
 * Only posts that are still upcoming (or due today) are exported.
 *
 *   node src/export-publisher.ts --brand brands/brandbasket [--publisher ../../publisher]
 */
import { access, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { composeCaption, parseWeekPlan, readJson } from './content.ts';

const WEEK_FILE = /^week-\d+\.json$/;
/** Keep posts from the last 20 hours so a post due today is still published. */
const KEEP_RECENT_MS = 20 * 60 * 60 * 1000;

export interface ExportedPost {
  id: string;
  date: string;
  caption: string;
  image: string;
}

export async function exportToPublisher(brandDir: string, publisherDir: string, now = Date.now()): Promise<ExportedPost[]> {
  const brand = basename(brandDir);
  const postsDir = join(publisherDir, 'public', 'posts', brand);
  await rm(postsDir, { recursive: true, force: true });
  await mkdir(postsDir, { recursive: true });

  const exported: ExportedPost[] = [];
  const files = (await readdir(brandDir)).filter((f) => WEEK_FILE.test(f)).sort();
  for (const file of files) {
    const plan = parseWeekPlan(await readJson(join(brandDir, file)), file);
    const outDir = resolve('out', brand, basename(file, '.json'));
    for (const post of plan.posts) {
      if (Date.parse(post.date) < now - KEEP_RECENT_MS) continue;
      const source = join(outDir, `${post.id}.jpg`);
      await access(source);
      await copyFile(source, join(postsDir, `${post.id}.jpg`));
      exported.push({
        id: `${brand}-${post.id}`,
        date: post.date,
        caption: composeCaption(post),
        image: `/posts/${brand}/${post.id}.jpg`,
      });
    }
  }
  exported.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  await writeFile(join(publisherDir, 'public', 'schedule.json'), `${JSON.stringify({ posts: exported }, null, 2)}\n`);
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
