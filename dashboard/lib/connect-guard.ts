import { verifyInvite } from './linkedin-flow.js';
import { isSignedIn, readCookie } from './security.js';

/** Remembers, for the 30 minutes a connection takes, the signed link the person came with. */
export const INVITE_COOKIE = 'connect_invite';
const TTL_SECONDS = 30 * 60;
const secureFlag = (secure: boolean): string => (secure ? 'Secure; ' : '');

export function inviteCookie(token: string, secure = process.env['COOKIE_INSECURE'] !== '1'): string {
  return `${INVITE_COOKIE}=${token}; HttpOnly; ${secureFlag(secure)}SameSite=Lax; Path=/api; Max-Age=${TTL_SECONDS}`;
}

export interface GuardOptions {
  /** True for a customer connecting their own account: one that another workspace holds is not taken by surprise. */
  guard: boolean;
  moveFrom?: string;
}

/**
 * What the publisher should enforce for this connection. Only the team (signed in, or a link the team made with the
 * session secret) may take an account another workspace holds. Everyone else is guarded, including a person whose
 * link cookie is missing or forged, so removing the cookie never turns the guard off.
 */
export function guardFor(request: Request): GuardOptions {
  if (isSignedIn(request, process.env['SESSION_SECRET'], Date.now())) return { guard: false };
  const token = readCookie(request.headers.get('cookie'), INVITE_COOKIE) ?? null;
  if (verifyInvite(token, process.env['SESSION_SECRET'], Date.now())) return { guard: false };
  const own = verifyInvite(token, process.env['INVITE_SECRET'], Date.now());
  return own?.moveFrom ? { guard: true, moveFrom: own.moveFrom } : { guard: true };
}

/** Adds the link cookie to the redirect that sends the person to the network, when they came through a link. */
export function attachInvite(response: Response, token: string | null): Response {
  if (token) response.headers.append('Set-Cookie', inviteCookie(token));
  return response;
}

/** When the publisher refused because another workspace already holds the account: the holder's id for the same customer's other brand, if it said one. */
export async function refusal(response: Response): Promise<{ heldBy?: string } | null> {
  if (response.status !== 409) return null;
  const body = (await response.json().catch(() => null)) as { code?: unknown; heldBy?: unknown } | null;
  if (body?.code !== 'ACCOUNT_IN_USE') return null;
  return typeof body.heldBy === 'string' ? { heldBy: body.heldBy } : {};
}
