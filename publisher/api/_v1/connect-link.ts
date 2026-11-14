/**
 * A link a product's customer opens to connect their own channel (they sign in on the platform and press Allow).
 *
 * POST /api/v1/connect-link   {"externalId": "<your id for the customer>", "channel": "linkedin" | "facebook" | "instagram" | "google", "returnUrl": "https://..."}
 *                             answers {"url": "...", "expiresInMinutes": 60}
 *
 * Optional "moveFrom": the externalId of another brand of the same customer. Without it, an account that another brand already
 * holds is refused (?reason=ACCOUNT_IN_USE&heldBy=...). With it, and only for that brand, the account moves after she confirmed.
 *
 * returnUrl must be one of the addresses registered for the product. Afterwards the customer is sent there with
 * ?social=connected|denied|failed&channel=<channel> added.
 */
import { findWorkspace, groupOf, isExternalId } from '../../lib/clients.js';
import { apiError, errorResponse } from '../../lib/api-error.js';
import { json } from '../../lib/http.js';
import { createInvite, PRODUCT_INVITE_TTL_SECONDS } from '../../lib/invite.js';
import { productOf } from '../../lib/product-request.js';
import { isReturnUrl } from '../../lib/products.js';
import { loadClients, storeConfigured } from '../../lib/store.js';

const MAX_BODY_BYTES = 2 * 1024;
const CHANNELS = ['linkedin', 'facebook', 'instagram', 'google'] as const;
/** Each platform has its own start page on the dashboard. */
const START_PAGE: Record<(typeof CHANNELS)[number], string> = { linkedin: '/api/linkedin-start', facebook: '/api/facebook-start', instagram: '/api/instagram-start', google: '/api/google/start' };

export async function POST(request: Request): Promise<Response> {
  const product = productOf(request);
  if (product instanceof Response) return product;
  if (!storeConfigured()) return apiError(503, 'STORAGE_NOT_SET_UP', 'storage is not set up');
  const secret = process.env['INVITE_SECRET'];
  const dashboard = process.env['DASHBOARD_ORIGIN'];
  if (!secret || secret.length < 32 || !dashboard) return apiError(503, 'CONNECT_LINKS_NOT_SET_UP', 'connect links are not set up');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return apiError(413, 'REQUEST_TOO_LARGE', 'request too large');

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return apiError(400, 'INVALID_REQUEST', 'send JSON');
  const { externalId, channel, returnUrl, moveFrom } = body;
  if (!isExternalId(externalId)) return apiError(400, 'INVALID_EXTERNAL_ID', 'externalId is required');
  const platform = CHANNELS.find((c) => c === channel);
  if (!platform) return apiError(400, 'INVALID_CHANNEL', `channel must be one of: ${CHANNELS.join(', ')}`);
  if (returnUrl !== undefined && (typeof returnUrl !== 'string' || !isReturnUrl(product, returnUrl))) {
    return apiError(400, 'RETURN_URL_NOT_REGISTERED', 'returnUrl is not one of the addresses registered for this product');
  }

  if (moveFrom !== undefined && !isExternalId(moveFrom)) return apiError(400, 'INVALID_MOVE_FROM', 'moveFrom must be the externalId of another brand of the same customer');

  try {
    const { file } = await loadClients();
    const workspace = findWorkspace(file, product.id, externalId);
    if (!workspace) return apiError(404, 'WORKSPACE_NOT_FOUND', 'no such workspace');
    if (moveFrom !== undefined) {
      const holder = findWorkspace(file, product.id, moveFrom);
      if (!holder || holder.brand === workspace.brand || groupOf(holder) !== groupOf(workspace)) {
        return apiError(400, 'INVALID_MOVE_FROM', 'moveFrom must be the externalId of another brand of the same customer');
      }
    }
    const invite = createInvite(secret, workspace.brand, Date.now(), returnUrl, undefined, moveFrom);
    return json(200, { url: `${dashboard.replace(/\/+$/, '')}${START_PAGE[platform]}?invite=${encodeURIComponent(invite)}`, expiresInMinutes: PRODUCT_INVITE_TTL_SECONDS / 60 });
  } catch (error) {
    return errorResponse(error, 'make the link');
  }
}
