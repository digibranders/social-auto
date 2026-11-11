/**
 * Uploads a picture for a post. The body is the JPG file itself (square, 320-4096 pixels, up to 4 MB).
 *
 * POST /api/v1/pictures    answers {"pictureId": "..."}, to use in POST /api/v1/posts
 */
import { apiError, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { storePicture } from '../../lib/manual-service.js';
import { MAX_IMAGE_BYTES } from '../../lib/overrides.js';
import { productOf } from '../../lib/product-request.js';
import { storeConfigured } from '../../lib/store.js';

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return apiError(413, 'PICTURE_TOO_LARGE', 'picture is too large');
  try {
    return json(201, { pictureId: await storePicture(new Uint8Array(await request.arrayBuffer())) });
  } catch (error) {
    return errorResponse(error, 'save the picture');
  }
}
