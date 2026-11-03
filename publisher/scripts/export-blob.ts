/**
 * Copies everything in the Vercel Blob store (edits, channels, the posted log, clients, hand-made posts and the edited
 * pictures) into a plain folder, keeping the same names, so the server can use it as LOCAL_STORE_DIR.
 *
 *   BLOB_READ_WRITE_TOKEN=... node scripts/export-blob.ts <folder> [--dry-run]
 *
 * It only reads from the store. Nothing is printed except file names and sizes; no contents.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { get, list } from '@vercel/blob';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const target = args.find((a) => !a.startsWith('--'));
if (!target) throw new Error('Usage: node scripts/export-blob.ts <folder> [--dry-run]');
if (!process.env['BLOB_READ_WRITE_TOKEN']) throw new Error('BLOB_READ_WRITE_TOKEN is not set');

const root = resolve(target);
let cursor: string | undefined;
let count = 0;
let bytes = 0;
do {
  const page = await list({ cursor, limit: 1000 });
  for (const blob of page.blobs) {
    const destination = resolve(root, blob.pathname);
    if (!destination.startsWith(root + sep)) throw new Error(`refusing a path outside the folder: ${blob.pathname}`);
    const result = await get(blob.pathname, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) throw new Error(`could not read ${blob.pathname}`);
    const content = Buffer.from(await new Response(result.stream).arrayBuffer());
    if (!dryRun) {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { mode: 0o600 });
    }
    count += 1;
    bytes += content.length;
    console.log(`${dryRun ? 'would copy' : 'copied'} ${blob.pathname} (${content.length} bytes)`);
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);
console.log(`${dryRun ? 'Would copy' : 'Copied'} ${count} files, ${bytes} bytes, to ${join(root)}`);
