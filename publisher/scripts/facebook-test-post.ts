/**
 * Posts one harmless test picture to the connected Facebook Page, or deletes a test post.
 *
 *   node --import ./dev/resolver.ts scripts/facebook-test-post.ts
 *   node --import ./dev/resolver.ts scripts/facebook-test-post.ts --delete <post id>
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deletePost, postPhoto } from '../lib/facebook.js';

interface SavedPage {
  pageId: string;
  pageName: string;
  pageToken: string;
}

const POSTERS = fileURLToPath(new URL('../public/posts/brandbasket', import.meta.url));

async function savedPage(): Promise<SavedPage> {
  try {
    const page = JSON.parse(await readFile(new URL('../.facebook-page.json', import.meta.url), 'utf8')) as Partial<SavedPage>;
    if (page.pageId && page.pageName && page.pageToken) return page as SavedPage;
  } catch {
    // fall through to the explanation below
  }
  throw new Error('No connected Page yet. Run scripts/connect-facebook.ts first.');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { delete: { type: 'string' } } });
  const page = await savedPage();

  if (values.delete) {
    await deletePost(values.delete, page.pageToken);
    console.log(`Deleted ${values.delete} from "${page.pageName}".`);
    return;
  }

  const file = (await readdir(POSTERS)).find((name) => name.endsWith('.jpg'));
  if (!file) throw new Error(`No poster found in ${POSTERS}`);
  const image = await readFile(join(POSTERS, file));
  const caption = 'Test post from the content calendar. Safe to delete.\n\n#test';
  const posted = await postPhoto(page.pageId, page.pageToken, image, caption);
  console.log(`Posted to "${page.pageName}". Photo ${posted.photoId}, post ${posted.postId ?? 'unknown'}.`);
  console.log(`Delete it with: --delete ${posted.postId ?? posted.photoId}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
