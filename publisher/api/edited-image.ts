/**
 * Serves a replacement picture chosen in the dashboard, so Instagram (and the dashboard) can fetch it.
 * The picture lives in a private store; this route is reachable only with its random 128-bit key,
 * which only the dashboard and the posting job ever see.
 *
 * GET /api/edited-image?k=<key>
 */
import { isImageKey } from '../lib/overrides.js';
import { loadImage } from '../lib/store.js';

export async function GET(request: Request): Promise<Response> {
  const key = new URL(request.url).searchParams.get('k');
  if (!isImageKey(key)) return new Response('Not found', { status: 404 });
  const stream = await loadImage(key);
  if (!stream) return new Response('Not found', { status: 404 });
  return new Response(stream, {
    headers: {
      'Content-Type': 'image/jpeg',
      // The key changes with every new picture, so a copy can be kept for good.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
