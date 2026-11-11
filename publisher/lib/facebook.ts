/** Minimal Facebook Graph API client for posting to a Facebook Page. */

/** Overridable only so local tests can talk to dev/fake-facebook.ts. */
const GRAPH = process.env['FACEBOOK_GRAPH_URL'] ?? 'https://graph.facebook.com/v23.0';

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

/** Posts a picture to the Page's timeline by address: Facebook fetches the picture itself. */
export async function postPhotoFromUrl(pageId: string, pageToken: string, imageUrl: string, caption: string): Promise<PostedPhoto> {
  const body = await graph('photo post', `/${pageId}/photos`, {
    method: 'POST',
    body: new URLSearchParams({ url: imageUrl, caption, published: 'true', access_token: pageToken }),
  });
  return { photoId: textOf(body, 'id', 'photo post'), postId: typeof body['post_id'] === 'string' ? body['post_id'] : null };
}

/** A post with several pictures holds two to ten of them. */
export const PHOTOS_MIN = 2;
export const PHOTOS_MAX = 10;

/**
 * Posts several pictures as one timeline post: each is uploaded unpublished (Facebook fetches it by address), then one post attaches them all in order.
 * The words belong to the post, not to any picture.
 */
export async function postPhotos(pageId: string, pageToken: string, imageUrls: readonly string[], caption: string): Promise<{ postId: string }> {
  if (imageUrls.length < PHOTOS_MIN || imageUrls.length > PHOTOS_MAX) {
    throw new FacebookApiError('photo post', `a post with several pictures needs ${PHOTOS_MIN} to ${PHOTOS_MAX} pictures, not ${imageUrls.length}`);
  }
  const photoIds: string[] = [];
  for (const url of imageUrls) {
    const uploaded = await graph('photo upload', `/${pageId}/photos`, { method: 'POST', body: new URLSearchParams({ url, published: 'false', access_token: pageToken }) });
    photoIds.push(textOf(uploaded, 'id', 'photo upload'));
  }
  const form = new URLSearchParams({ message: caption, access_token: pageToken });
  photoIds.forEach((id, i) => form.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  const post = await graph('photo post', `/${pageId}/feed`, { method: 'POST', body: form });
  return { postId: textOf(post, 'id', 'photo post') };
}

/** The public address of a post, or null when Facebook does not give one. */
export async function postLink(postId: string, pageToken: string): Promise<string | null> {
  const params = new URLSearchParams({ fields: 'permalink_url', access_token: pageToken });
  const body = await graph('post link', `/${postId}?${params}`);
  return typeof body['permalink_url'] === 'string' ? body['permalink_url'] : null;
}

/** Whether the saved Page token still works. */
export async function pageHealth(pageId: string, pageToken: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await graph('page check', `/${pageId}?${new URLSearchParams({ fields: 'id', access_token: pageToken })}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
