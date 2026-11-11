/**
 * Checks that Instagram accepts a carousel for the team's Instagram account, WITHOUT publishing anything. It makes one container per picture and then the
 * carousel container, waits until each is ready, and prints their ids and that they finished. The containers are never published; Instagram drops them on
 * its own after about a day. The pictures must be public JPEG addresses (Instagram fetches them itself).
 *
 * On the server, as the user that runs the publisher:
 *   set -a; . /etc/social-auto/publisher.env; set +a
 *   node --import ./dev/resolver.ts scripts/instagram-carousel-check.ts --images https://a.example/1.jpg,https://a.example/2.jpg,https://a.example/3.jpg
 *
 * Needs INSTAGRAM_USER_ID and INSTAGRAM_TOKEN, the same two settings the publisher uses for the team's account. Nothing here publishes: there is no flag for it.
 */
import { parseArgs } from 'node:util';
import { CAROUSEL_MAX, CAROUSEL_MIN, prepareCarousel } from '../lib/instagram.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Load the publisher's settings first (see the top of this file).`);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { images: { type: 'string' }, caption: { type: 'string' } } });
  const urls = (values.images ?? '').split(',').map((u) => u.trim()).filter(Boolean);
  if (urls.length < CAROUSEL_MIN || urls.length > CAROUSEL_MAX) throw new Error(`Give ${CAROUSEL_MIN} to ${CAROUSEL_MAX} public picture addresses: --images https://a/1.jpg,https://a/2.jpg`);
  if (urls.some((u) => !/^https:\/\//.test(u))) throw new Error('Every picture address must start with https://');
  const made = await prepareCarousel(required('INSTAGRAM_USER_ID'), required('INSTAGRAM_TOKEN'), urls, values.caption ?? 'Carousel check. Never published.');
  console.log(`Instagram accepted the carousel: ${made.itemIds.length} pictures, carousel container ${made.containerId}, status FINISHED.`);
  console.log('Nothing was published. The containers expire on their own.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
