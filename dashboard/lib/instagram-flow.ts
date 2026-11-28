import { clearedCookieFor, connectCookieFor } from './facebook-flow.js';
import { siteOrigin } from './linkedin-flow.js';

/**
 * The "Connect Instagram" hand-off. Like LinkedIn, the person who presses Allow is usually the client, so they
 * arrive with a signed invite link (see linkedin-flow.ts) and the same state cookie checks the way back.
 */
export const INSTAGRAM_COOKIE = 'ig_connect';
const AUTHORIZE = process.env['INSTAGRAM_AUTHORIZE_URL'] ?? 'https://www.instagram.com/oauth/authorize';
/** Read the profile, publish posts, and reply to comments via Auto-DM. */
const SCOPE = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages,instagram_business_manage_comments';

export const connectCookie = (state: string, brand: string, returnUrl: string | null = null, secure?: boolean): string =>
  connectCookieFor(INSTAGRAM_COOKIE, state, brand, returnUrl, secure);

export const clearedConnectCookie = (secure?: boolean): string => clearedCookieFor(INSTAGRAM_COOKIE, secure);

/** Where Instagram sends the person back to. It must match, exactly, an address saved in the Meta app. */
export const callbackUrl = (request: Request): string => `${siteOrigin(request)}/api/instagram-callback`;

export function authorizeLink(options: { appId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: options.appId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    state: options.state,
  });
  return `${AUTHORIZE}?${params}`;
}

/**
 * Facebook login (INSTAGRAM_LOGIN=facebook): Meta's "Unified Login" for newer apps. The permissions and the account chooser come from a saved
 * configuration (INSTAGRAM_CONFIG_ID in the Meta app), so no scope is passed. The way back is the same callback.
 */
export const usesFacebookLogin = (): boolean => process.env['INSTAGRAM_LOGIN'] === 'facebook';

export function facebookLoginLink(options: { appId: string; configId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({ client_id: options.appId, config_id: options.configId, redirect_uri: options.redirectUri, response_type: 'code', state: options.state });
  return `${process.env['FACEBOOK_AUTHORIZE_URL'] ?? 'https://www.facebook.com/dialog/oauth'}?${params}`;
}
