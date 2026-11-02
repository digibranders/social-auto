/** Minimal Instagram Graph API client (Instagram API with Instagram Login). */

/** Instagram's addresses. The environment can point them at a pretend Instagram for local testing (see dev/fake-instagram.ts). */
const ROOT = process.env['INSTAGRAM_GRAPH_URL'] ?? 'https://graph.instagram.com';
const GRAPH = `${ROOT}/v23.0`;
const TOKEN_URL = process.env['INSTAGRAM_TOKEN_URL'] ?? 'https://api.instagram.com/oauth/access_token';
const STATUS_POLL_MS = 3_000;
const STATUS_MAX_POLLS = 15;

export class InstagramApiError extends Error {
  constructor(step: string, detail: string) {
    super(`Instagram ${step} failed: ${detail.slice(0, 400)}`);
    this.name = 'InstagramApiError';
  }
}

async function graph(step: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${GRAPH}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body['error']) throw new InstagramApiError(step, JSON.stringify(body['error'] ?? body));
  return body;
}

export interface RefreshedToken {
  token: string;
  expiresInDays: number;
}

/**
 * Extends a long-lived token's life (about 60 days). Instagram only allows this for tokens at least
 * 24 hours old that are still valid. The refresh endpoint is not versioned, unlike the rest of the API.
 */
export async function refreshToken(token: string): Promise<RefreshedToken> {
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
  const response = await fetch(`${ROOT}/refresh_access_token?${params}`, {
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || body['error'] || typeof body['access_token'] !== 'string') {
    throw new InstagramApiError('refresh token', JSON.stringify(body['error'] ?? body));
  }
  return { token: body['access_token'], expiresInDays: Math.floor(Number(body['expires_in']) / 86_400) };
}

export interface RecentMedia {
  id: string;
  caption: string;
  timestamp: string;
}

export async function recentMedia(userId: string, token: string, limit = 10): Promise<RecentMedia[]> {
  const params = new URLSearchParams({ fields: 'id,caption,timestamp', limit: String(limit), access_token: token });
  const body = await graph('list media', `/${userId}/media?${params}`);
  const data = Array.isArray(body['data']) ? (body['data'] as Array<Record<string, unknown>>) : [];
  return data.map((m) => ({ id: String(m['id']), caption: String(m['caption'] ?? ''), timestamp: String(m['timestamp'] ?? '') }));
}

/** A post on the account, as the dashboard needs it. */
export interface AccountMedia {
  id: string;
  caption: string;
  timestamp: string;
  permalink: string;
  /** The picture as Instagram serves it; the link is temporary. */
  mediaUrl: string | null;
}

const MEDIA_PAGE_SIZE = 100;
const MEDIA_MAX_PAGES = 20;

/** The account's posts newer than `sinceMs`, newest first, following Instagram's paging. */
export async function mediaSince(userId: string, token: string, sinceMs: number): Promise<AccountMedia[]> {
  const params = new URLSearchParams({
    fields: 'id,caption,timestamp,permalink,media_type,media_url,thumbnail_url',
    limit: String(MEDIA_PAGE_SIZE),
    access_token: token,
  });
  let url: string | null = `${GRAPH}/${userId}/media?${params}`;
  const out: AccountMedia[] = [];
  for (let page = 0; url !== null && page < MEDIA_MAX_PAGES; page++) {
    const response: Response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok || body['error']) throw new InstagramApiError('list media', JSON.stringify(body['error'] ?? body));
    const data = Array.isArray(body['data']) ? (body['data'] as Array<Record<string, unknown>>) : [];
    for (const item of data) {
      if (Date.parse(String(item['timestamp'])) < sinceMs) return out;
      const picture = item['media_type'] === 'VIDEO' ? item['thumbnail_url'] : item['media_url'];
      out.push({
        id: String(item['id']),
        caption: String(item['caption'] ?? ''),
        timestamp: String(item['timestamp'] ?? ''),
        permalink: String(item['permalink'] ?? ''),
        mediaUrl: typeof picture === 'string' ? picture : null,
      });
    }
    const paging = body['paging'] as { next?: unknown } | undefined;
    url = typeof paging?.next === 'string' ? paging.next : null;
  }
  return out;
}

export interface AccountProfile {
  username: string | null;
  /** The profile picture; the link is temporary. */
  pictureUrl: string | null;
}

export async function accountProfile(token: string): Promise<AccountProfile> {
  const params = new URLSearchParams({ fields: 'username,profile_picture_url', access_token: token });
  const body = await graph('read account', `/me?${params}`);
  return {
    username: typeof body['username'] === 'string' ? body['username'] : null,
    pictureUrl: typeof body['profile_picture_url'] === 'string' ? body['profile_picture_url'] : null,
  };
}

/** Step 1: Instagram downloads the image and prepares an unpublished container. */
export async function createImageContainer(userId: string, token: string, imageUrl: string, caption: string): Promise<string> {
  const form = new URLSearchParams({ image_url: imageUrl, caption, access_token: token });
  const body = await graph('create container', `/${userId}/media`, { method: 'POST', body: form });
  return String(body['id']);
}

/** Waits until Instagram has finished processing the container. */
export async function waitUntilReady(containerId: string, token: string): Promise<void> {
  for (let i = 0; i < STATUS_MAX_POLLS; i++) {
    const params = new URLSearchParams({ fields: 'status_code,status', access_token: token });
    const body = await graph('check container', `/${containerId}?${params}`);
    const status = String(body['status_code'] ?? '');
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new InstagramApiError('process container', `${status}: ${String(body['status'] ?? '')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
  throw new InstagramApiError('process container', 'timed out waiting for FINISHED');
}

/** Step 2: makes the prepared container a live post. */
export async function publishContainer(userId: string, token: string, containerId: string): Promise<string> {
  const form = new URLSearchParams({ creation_id: containerId, access_token: token });
  const body = await graph('publish', `/${userId}/media_publish`, { method: 'POST', body: form });
  return String(body['id']);
}

export async function permalink(mediaId: string, token: string): Promise<string> {
  const params = new URLSearchParams({ fields: 'permalink', access_token: token });
  const body = await graph('permalink', `/${mediaId}?${params}`);
  return String(body['permalink'] ?? '');
}

/** What a customer approves when they connect their own Instagram: reading the profile and publishing posts. */
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'] as const;

export interface InstagramApp {
  appId: string;
  appSecret: string;
}

/** Swaps the one-time code from the redirect for a short-lived token (about an hour). Secrets go in the body, never the address. */
export async function exchangeCode(app: InstagramApp, redirectUri: string, code: string): Promise<{ accessToken: string }> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body['error_message'] || typeof body['access_token'] !== 'string') {
    throw new InstagramApiError('code exchange', JSON.stringify(body['error_message'] ?? body['error'] ?? { status: response.status }));
  }
  return { accessToken: body['access_token'] };
}

export interface LongLivedToken {
  /** Secret: never print or log it. */
  accessToken: string;
  expiresInSeconds: number;
}

/** Trades the short-lived token for one that lasts about 60 days and can be renewed (see refreshToken). */
export async function longLivedToken(app: InstagramApp, shortToken: string): Promise<LongLivedToken> {
  const params = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: app.appSecret, access_token: shortToken });
  const response = await fetch(`${ROOT}/access_token?${params}`, { signal: AbortSignal.timeout(30_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || body['error'] || typeof body['access_token'] !== 'string' || typeof body['expires_in'] !== 'number') {
    throw new InstagramApiError('token upgrade', JSON.stringify(body['error'] ?? { status: response.status }));
  }
  return { accessToken: body['access_token'], expiresInSeconds: body['expires_in'] };
}

export interface InstagramAccount {
  /** The account's own id, used in every posting call. */
  userId: string;
  username: string;
}

/** Who the token belongs to. */
export async function accountOf(token: string): Promise<InstagramAccount> {
  const params = new URLSearchParams({ fields: 'user_id,username', access_token: token });
  const body = await graph('read account', `/me?${params}`);
  const userId = body['user_id'] ?? body['id'];
  if ((typeof userId !== 'string' && typeof userId !== 'number') || typeof body['username'] !== 'string' || !body['username']) {
    throw new InstagramApiError('read account', 'the answer had no account id or username');
  }
  return { userId: String(userId), username: body['username'] };
}

/** Whether a saved token is still accepted. */
export async function tokenHealth(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await graph('account check', `/me?${new URLSearchParams({ fields: 'user_id', access_token: token })}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
