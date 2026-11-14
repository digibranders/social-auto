import { createHmac } from 'node:crypto';

/** How long a connect link a product asked for stays valid. Short, because it is made on demand. */
export const PRODUCT_INVITE_TTL_SECONDS = 60 * 60;

/**
 * Makes the signed link a customer opens to connect their own channel. The dashboard checks the same signature
 * (with the same INVITE_SECRET), so the client it names and the page it returns to cannot be changed on the way.
 * The format matches the dashboard's own links: base64url({b, e, r}) + "." + HMAC.
 */
export function createInvite(secret: string, brand: string, nowMs: number, returnUrl?: string, ttlSeconds = PRODUCT_INVITE_TTL_SECONDS, moveFrom?: string): string {
  // g: the customer's own link, so an account another workspace already holds is never taken by surprise; m: the one brand she agreed to take it from.
  const payload = Buffer.from(JSON.stringify({ b: brand, e: Math.floor(nowMs / 1000) + ttlSeconds, g: 1, ...(returnUrl ? { r: returnUrl } : {}), ...(moveFrom ? { m: moveFrom } : {}) })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`linkedin-invite.${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}
