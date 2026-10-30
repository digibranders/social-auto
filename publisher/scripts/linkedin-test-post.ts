/**
 * Posts one harmless test picture to your connected LinkedIn profile, or deletes a test post.
 * The test post is visible to your connections only.
 *
 *   node --import ./dev/resolver.ts scripts/linkedin-test-post.ts
 *   node --import ./dev/resolver.ts scripts/linkedin-test-post.ts --delete urn:li:share:123
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deletePost, postImage, uploadImage } from '../lib/linkedin.js';

interface Saved {
  accessToken: string;
  memberUrn: string;
  memberName: string;
  expiresAt: string;
}

const POSTERS = fileURLToPath(new URL('../public/posts/brandbasket', import.meta.url));

async function saved(): Promise<Saved> {
  try {
    const value = JSON.parse(await readFile(new URL('../.linkedin-token.json', import.meta.url), 'utf8')) as Partial<Saved>;
    if (value.accessToken && value.memberUrn && value.memberName && value.expiresAt) {
      if (Date.parse(value.expiresAt) < Date.now()) throw new Error('The saved LinkedIn token has expired. Connect again.');
      return value as Saved;
    }
  } catch (error) {
    if (error instanceof Error && /expired/.test(error.message)) throw error;
  }
  throw new Error('No connected LinkedIn profile yet. Run scripts/connect-linkedin.ts first.');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { delete: { type: 'string' } } });
  const me = await saved();

  if (values.delete) {
    await deletePost(me.accessToken, values.delete);
    console.log(`Deleted ${values.delete} from ${me.memberName}'s profile.`);
    return;
  }

  const file = (await readdir(POSTERS)).find((name) => name.endsWith('.jpg'));
  if (!file) throw new Error(`No poster found in ${POSTERS}`);
  const asset = await uploadImage(me.accessToken, me.memberUrn, await readFile(join(POSTERS, file)));
  const post = await postImage(me.accessToken, me.memberUrn, asset, 'Test post from the content calendar. Safe to delete.\n\n#test', 'CONNECTIONS');
  console.log(`Posted to ${me.memberName}'s profile (connections only): ${post.url}`);
  console.log(`Delete it with: --delete ${post.urn}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
