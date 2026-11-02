/**
 * Posts one harmless test update to your connected Google listing, or deletes a test update.
 * Google downloads the picture from a public address, so the test uses a poster published by the publisher.
 *
 *   node --import ./dev/resolver.ts scripts/google-test-post.ts
 *   node --import ./dev/resolver.ts scripts/google-test-post.ts --delete accounts/1/locations/2/localPosts/3
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { accessTokenFor, createPost, deletePost } from '../lib/google.js';

interface Saved {
  refreshToken: string;
  account: string;
  location: string;
  title: string;
}

const POSTERS = fileURLToPath(new URL('../public/posts/brandbasket', import.meta.url));
const PUBLIC_POSTERS = 'https://social-publisher-lovat.vercel.app/posts/brandbasket';

async function saved(): Promise<Saved> {
  try {
    const value = JSON.parse(await readFile(new URL('../.google-token.json', import.meta.url), 'utf8')) as Partial<Saved>;
    if (value.refreshToken && value.account && value.location && value.title) return value as Saved;
  } catch {
    // fall through to the message below
  }
  throw new Error('No connected Google listing yet. Run scripts/connect-google.ts first.');
}

async function main(): Promise<void> {
  process.loadEnvFile(new URL('../../scheduler/upstream/.env', import.meta.url));
  const app = { clientId: process.env['GOOGLE_CLIENT_ID'] ?? '', clientSecret: process.env['GOOGLE_CLIENT_SECRET'] ?? '' };
  if (!app.clientId || !app.clientSecret) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in scheduler/upstream/.env');
  const { values } = parseArgs({ options: { delete: { type: 'string' } } });
  const me = await saved();
  const token = await accessTokenFor(app, me.refreshToken);

  if (values.delete) {
    await deletePost(token, values.delete);
    console.log(`Deleted ${values.delete} from "${me.title}".`);
    return;
  }

  const file = (await readdir(POSTERS)).find((name) => name.endsWith('.jpg'));
  if (!file) throw new Error(`No poster found in ${POSTERS}`);
  const imageUrl = `${PUBLIC_POSTERS}/${file}`;
  const post = await createPost(token, me.account, me.location, { summary: 'Test update from the content calendar. Safe to delete.', imageUrl });
  console.log(`Posted an update to "${me.title}". Look under Updates on the listing (Search or Maps), or in Business Profile Manager.`);
  if (post.url) console.log(`Google link: ${post.url}`);
  console.log(`Delete it with: --delete ${post.name}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
