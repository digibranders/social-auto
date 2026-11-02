/**
 * Uploads a picture for a post. The body is the JPG file itself (square, 320-4096 pixels, up to 4 MB).
 *
 * POST /api/v1/pictures    answers {"pictureId": "..."}, to use in POST /api/v1/posts
 */
import { describeError, json } from '../../lib/http.js';
import { storePicture } from '../../lib/manual-service.js';
import { EditError, MAX_IMAGE_BYTES } from '../../lib/overrides.js';
import { productOf } from '../../lib/product-request.js';
import { storeConfigured } from '../../lib/store.js';

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return json(413, { error: 'picture is too large' });
  try {
    return json(201, { pictureId: await storePicture(new Uint8Array(await request.arrayBuffer())) });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save the picture' });
  }
}
