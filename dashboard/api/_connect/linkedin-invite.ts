/**
 * POST /api/linkedin-invite?brand=<client>[&channel=instagram|facebook|google]
 * Makes a link a client (or you, in another browser) can open to connect LinkedIn, Instagram, Facebook or Google. Signed-in people only,
 * from this site's pages. (The address keeps its first name so links and callers made earlier keep working.)
 */
import { json } from '../../lib/http.js';
import { isBrand } from '../../lib/facebook-flow.js';
import { createInvite, INVITE_TTL_SECONDS, siteOrigin } from '../../lib/linkedin-flow.js';
import { isSameOrigin, isSignedIn } from '../../lib/security.js';

export function POST(request: Request): Response {
  const secret = process.env['SESSION_SECRET'];
  if (!isSignedIn(request, secret, Date.now())) return json(401, { error: 'Not signed in' });
  if (!isSameOrigin(request)) return json(403, { error: 'Request not allowed' });
  const params = new URL(request.url).searchParams;
  const channel = params.get('channel');
  const platform = channel === 'instagram' ? 'instagram' : channel === 'facebook' ? 'facebook' : channel === 'google' ? 'google' : 'linkedin';
  const configured = { instagram: 'INSTAGRAM_APP_ID', facebook: 'FACEBOOK_APP_ID', linkedin: 'LINKEDIN_CLIENT_ID', google: 'GOOGLE_CLIENT_ID' }[platform];
  const name = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', google: 'Google' }[platform];
  if (!secret || !process.env[configured]) return json(503, { error: `${name} is not configured` });

  const brand = params.get('brand');
  if (!isBrand(brand)) return json(400, { error: 'Invalid client' });

  const invite = createInvite(secret, brand, Date.now());
  return json(200, {
    link: `${siteOrigin(request)}/api/${platform === 'google' ? 'google/start' : `${platform}-start`}?invite=${encodeURIComponent(invite)}`,
    expiresInDays: INVITE_TTL_SECONDS / 86_400,
  });
}
