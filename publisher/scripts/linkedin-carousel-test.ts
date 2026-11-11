/**
 * Posts a small test carousel (2 to 10 pictures) to your connected LinkedIn profile through the Posts API, or deletes a test post. The test post is visible
 * to your connections only unless --public is given. This proves LinkedIn accepts OUR calls for a carousel; it publishes nothing for any client.
 *
 *   node --import ./dev/resolver.ts scripts/linkedin-carousel-test.ts --images a.jpg,b.jpg,c.jpg [--token-file path] [--public]
 *   node --import ./dev/resolver.ts scripts/linkedin-carousel-test.ts --delete urn:li:share:123 [--token-file path]
 *
 * The token file is the one scripts/connect-linkedin.ts saved (../.linkedin-token.json); the key in it is never printed.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { deleteRestPost, postMultiImage, uploadImageUrn } from '../lib/linkedin.js';

interface Saved {
  accessToken: string;
  memberUrn: string;
  memberName: string;
  expiresAt: string;
}

async function saved(file: string): Promise<Saved> {
  const value = JSON.parse(await readFile(file, 'utf8')) as Partial<Saved>;
  if (!value.accessToken || !value.memberUrn || !value.memberName || !value.expiresAt) throw new Error('That token file is incomplete. Run scripts/connect-linkedin.ts first.');
  if (Date.parse(value.expiresAt) < Date.now()) throw new Error('The saved LinkedIn token has expired. Connect again.');
  return value as Saved;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { images: { type: 'string' }, delete: { type: 'string' }, 'token-file': { type: 'string' }, public: { type: 'boolean' } } });
  const me = await saved(values['token-file'] ?? new URL('../.linkedin-token.json', import.meta.url).pathname);

  if (values.delete) {
    await deleteRestPost(me.accessToken, values.delete);
    console.log(`Deleted ${values.delete} from ${me.memberName}'s profile.`);
    return;
  }

  const files = (values.images ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  if (files.length < 2) throw new Error('Give at least two pictures: --images a.jpg,b.jpg');
  const images = [];
  for (const [i, file] of files.entries()) {
    const urn = await uploadImageUrn(me.accessToken, me.memberUrn, await readFile(file));
    images.push({ urn, altText: `Test slide ${i + 1} of ${files.length}` });
    console.log(`Uploaded ${file} as ${urn}`);
  }
  const post = await postMultiImage(me.accessToken, me.memberUrn, images, 'Carousel test from the content calendar. Safe to delete.\n\n#test', values.public ? 'PUBLIC' : 'CONNECTIONS');
  console.log(`Posted ${files.length} pictures to ${me.memberName}'s profile (${values.public ? 'public' : 'connections only'}): ${post.url}`);
  console.log(`Delete it with: --delete ${post.urn}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
