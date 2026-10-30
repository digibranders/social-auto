/** Minimal Facebook Graph API client for posting to a Facebook Page. */

const GRAPH = 'https://graph.facebook.com/v23.0';

/** What the app asks the person to approve: list their Pages, post to them, read their post status. */
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'] as const;

export class FacebookApiError extends Error {
  constructor(step: string, detail: string) {
    super(`Facebook ${step} failed: ${detail.slice(0, 400)}`);
    this.name = 'FacebookApiError';
  }
}

async function graph(step: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${GRAPH}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body['error']) throw new FacebookApiError(step, JSON.stringify(body['error'] ?? body));
  return body;
}

function textOf(body: Record<string, unknown>, key: string, step: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value) throw new FacebookApiError(step, `no "${key}" in the answer`);
  return value;
}

export interface AuthorizeOptions {
  appId: string;
  redirectUri: string;
  /** Random value echoed back by Facebook; the caller must check it to stop forged callbacks. */
  state: string;
  /** Only for apps that use "Facebook Login for Business", which takes a configuration instead of scopes. */
  configId?: string;
}

/** The Facebook page where the person approves the app. */
export function authorizeUrl({ appId, redirectUri, state, configId }: AuthorizeOptions): string {
  const params = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, response_type: 'code' });
  if (configId) params.set('config_id', configId);
  else params.set('scope', FACEBOOK_SCOPES.join(','));
  return `https://www.facebook.com/v23.0/dialog/oauth?${params}`;
}

export interface AppCredentials {
  appId: string;
  appSecret: string;
}

/** Swaps the one-time code from the redirect for a short-lived user token. */
export async function exchangeCode(app: AppCredentials, redirectUri: string, code: string): Promise<string> {
  const body = new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, redirect_uri: redirectUri, code });
  return textOf(await graph('code exchange', '/oauth/access_token', { method: 'POST', body }), 'access_token', 'code exchange');
}

/** Trades a short-lived user token for a long-lived one (about 60 days). Page tokens made from it do not expire. */
export async function longLivedUserToken(app: AppCredentials, token: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: app.appId,
    client_secret: app.appSecret,
    fb_exchange_token: token,
  });
  return textOf(await graph('token upgrade', '/oauth/access_token', { method: 'POST', body }), 'access_token', 'token upgrade');
}

export interface FacebookPage {
  id: string;
  name: string;
  /** Token that posts as the Page. Secret: never print or log it. */
  accessToken: string;
}

/** The Pages the person manages and approved for this app. */
export async function listPages(userToken: string): Promise<FacebookPage[]> {
  const params = new URLSearchParams({ fields: 'id,name,access_token', limit: '100', access_token: userToken });
  const body = await graph('list pages', `/me/accounts?${params}`);
  const data = Array.isArray(body['data']) ? (body['data'] as Array<Record<string, unknown>>) : [];
  return data.flatMap((p) =>
    typeof p['id'] === 'string' && typeof p['access_token'] === 'string'
      ? [{ id: p['id'], name: String(p['name'] ?? p['id']), accessToken: p['access_token'] }]
      : [],
  );
}

export interface PostedPhoto {
  /** The photo object's id. */
  photoId: string;
  /** The post on the Page's timeline, when Facebook reports it. */
  postId: string | null;
}

/** Posts a picture with a caption to the Page's timeline, uploading the picture's bytes directly. */
export async function postPhoto(pageId: string, pageToken: string, image: Uint8Array, caption: string): Promise<PostedPhoto> {
  const form = new FormData();
  form.set('caption', caption);
  form.set('published', 'true');
  form.set('access_token', pageToken);
  form.set('source', new Blob([Buffer.from(image)], { type: 'image/jpeg' }), 'post.jpg');
  const body = await graph('photo post', `/${pageId}/photos`, { method: 'POST', body: form });
  return { photoId: textOf(body, 'id', 'photo post'), postId: typeof body['post_id'] === 'string' ? body['post_id'] : null };
}

/** Removes a post by its id (used to clean up test posts). */
export async function deletePost(postId: string, pageToken: string): Promise<void> {
  const body = await graph('delete post', `/${postId}`, {
    method: 'DELETE',
    body: new URLSearchParams({ access_token: pageToken }),
  });
  if (body['success'] !== true) throw new FacebookApiError('delete post', JSON.stringify(body));
}
