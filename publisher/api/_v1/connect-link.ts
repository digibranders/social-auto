/**
 * A link a product's customer opens to connect their own channel (they sign in on the platform and press Allow).
 *
 * POST /api/v1/connect-link   {"externalId": "<your id for the customer>", "channel": "linkedin" | "facebook" | "instagram" | "google", "returnUrl": "https://..."}
 *                             answers {"url": "...", "expiresInMinutes": 60}
 *
 * returnUrl must be one of the addresses registered for the product. Afterwards the customer is sent there with
 * ?social=connected|denied|failed&channel=<channel> added.
 */
import { findWorkspace, isExternalId } from '../../lib/clients.js';
import { describeError, json } from '../../lib/http.js';
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
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  const secret = process.env['INVITE_SECRET'];
  const dashboard = process.env['DASHBOARD_ORIGIN'];
  if (!secret || secret.length < 32 || !dashboard) return json(503, { error: 'connect links are not set up' });
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null) return json(400, { error: 'send JSON' });
  const { externalId, channel, returnUrl } = body;
  if (!isExternalId(externalId)) return json(400, { error: 'externalId is required' });
  const platform = CHANNELS.find((c) => c === channel);
  if (!platform) return json(400, { error: `channel must be one of: ${CHANNELS.join(', ')}` });
  if (returnUrl !== undefined && (typeof returnUrl !== 'string' || !isReturnUrl(product, returnUrl))) {
    return json(400, { error: 'returnUrl is not one of the addresses registered for this product' });
  }

  try {
    const { file } = await loadClients();
    const workspace = findWorkspace(file, product.id, externalId);
    if (!workspace) return json(404, { error: 'no such workspace' });
    const invite = createInvite(secret, workspace.brand, Date.now(), returnUrl);
    return json(200, { url: `${dashboard.replace(/\/+$/, '')}${START_PAGE[platform]}?invite=${encodeURIComponent(invite)}`, expiresInMinutes: PRODUCT_INVITE_TTL_SECONDS / 60 });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'could not make the link' });
  }
}
