/**
 * POST /api/linkedin-invite?brand=<client>[&channel=instagram]
 * Makes a link a client can open to connect their own LinkedIn (or Instagram). Signed-in people only, from this site's pages.
 */
import { json } from '../lib/http.js';
import { isBrand } from '../lib/facebook-flow.js';
import { createInvite, INVITE_TTL_SECONDS, siteOrigin } from '../lib/linkedin-flow.js';
import { isSameOrigin, isSignedIn } from '../lib/security.js';

export function POST(request: Request): Response {
  const secret = process.env['SESSION_SECRET'];
  if (!isSignedIn(request, secret, Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });
  const params = new URL(request.url).searchParams;
  const instagram = params.get('channel') === 'instagram';
  if (!secret || !process.env[instagram ? 'INSTAGRAM_APP_ID' : 'LINKEDIN_CLIENT_ID']) return json(503, { error: `${instagram ? 'Instagram' : 'LinkedIn'} is not configured` });

  const brand = params.get('brand');
  if (!isBrand(brand)) return json(400, { error: 'Invalid client' });

  const invite = createInvite(secret, brand, Date.now());
  return json(200, {
    link: `${siteOrigin(request)}/api/${instagram ? 'instagram' : 'linkedin'}-start?invite=${encodeURIComponent(invite)}`,
    expiresInDays: INVITE_TTL_SECONDS / 86_400,
  });
}
