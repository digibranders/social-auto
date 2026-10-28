/**
 * Daily Vercel Cron: publishes the post that is due today to Instagram.
 *
 * GET /api/cron            (called by Vercel Cron with Authorization: Bearer $CRON_SECRET)
 * GET /api/cron?dryRun=1   prepares the Instagram container without publishing it
 * GET /api/cron?dryRun=1&post=<id>   same, for a named post regardless of its date
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createImageContainer,
  permalink,
  publishContainer,
  recentMedia,
  waitUntilReady,
} from '../lib/instagram.js';
import { duePost, parseSchedule, sameCaption } from '../lib/schedule.js';

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env['CRON_SECRET'];
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json(401, { error: 'unauthorized' });
  }

  try {
    const token = requireEnv('INSTAGRAM_TOKEN');
    const userId = requireEnv('INSTAGRAM_USER_ID');
    const url = new URL(request.url);
    const origin = process.env['PUBLIC_ORIGIN'] ?? url.origin;
    const dryRun = url.searchParams.get('dryRun') === '1';

    // Bundled with the function (vercel.json includeFiles); not served publicly.
    const schedule = parseSchedule(JSON.parse(await readFile(join(process.cwd(), 'data', 'schedule.json'), 'utf8')));
    // A specific post can be named only in dry-run mode, to test the pipeline before its day.
    const testPostId = dryRun ? url.searchParams.get('post') : null;
    const post = testPostId ? (schedule.find((p) => p.id === testPostId) ?? null) : duePost(schedule, Date.now());
    if (!post) return json(200, { status: testPostId ? 'post-not-found' : 'nothing-due' });

    const alreadyLive = (await recentMedia(userId, token)).find((m) => sameCaption(m.caption, post.caption));
    if (alreadyLive) return json(200, { status: 'already-published', post: post.id, media: alreadyLive.id });

    const containerId = await createImageContainer(userId, token, `${origin}${post.image}`, post.caption);
    await waitUntilReady(containerId, token);
    if (dryRun) return json(200, { status: 'dry-run-ready', post: post.id, container: containerId });

    const mediaId = await publishContainer(userId, token, containerId);
    const link = await permalink(mediaId, token).catch(() => '');
    console.log(`published ${post.id} as ${mediaId} ${link}`);
    return json(200, { status: 'published', post: post.id, media: mediaId, permalink: link });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(message);
    return json(500, { status: 'failed', error: message });
  }
}
