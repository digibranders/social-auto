/** Minimal LinkedIn client for posting a picture as a member ("Share on LinkedIn", scope w_member_social). */

/** LinkedIn's addresses. The environment can point them at a pretend LinkedIn for local testing (see dev/fake-linkedin.ts). */
const AUTHORIZE = process.env['LINKEDIN_AUTHORIZE_URL'] ?? 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN = process.env['LINKEDIN_TOKEN_URL'] ?? 'https://www.linkedin.com/oauth/v2/accessToken';
const API = process.env['LINKEDIN_API_URL'] ?? 'https://api.linkedin.com';

/** Sign-in (OpenID: openid, profile) plus permission to post as the member. */
export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social'] as const;

export class LinkedInApiError extends Error {
  constructor(step: string, detail: string) {
    super(`LinkedIn ${step} failed: ${detail.slice(0, 400)}`);
    this.name = 'LinkedInApiError';
  }
}

export interface LinkedInApp {
  clientId: string;
  clientSecret: string;
}

export function authorizeUrl(options: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    scope: LINKEDIN_SCOPES.join(' '),
  });
  return `${AUTHORIZE}?${params}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
}

export interface LinkedInToken {
  /** Secret: never print or log it. */
  accessToken: string;
  /** About 60 days; LinkedIn gives no refresh token to self-serve apps, so the member must reconnect. */
  expiresInSeconds: number;
}

/** Swaps the one-time code from the redirect for an access token. Secrets go in the body, never the address. */
export async function exchangeCode(app: LinkedInApp, redirectUri: string, code: string): Promise<LinkedInToken> {
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body['access_token'] !== 'string') {
    throw new LinkedInApiError('code exchange', JSON.stringify(body['error_description'] ?? body['error'] ?? body));
  }
  return { accessToken: body['access_token'], expiresInSeconds: Number(body['expires_in'] ?? 0) };
}

export interface LinkedInMember {
  /** "urn:li:person:<id>", the author of a post. */
  urn: string;
  name: string;
}

/** Who the token belongs to, through "Sign In with LinkedIn using OpenID Connect". */
export async function memberOf(token: string): Promise<LinkedInMember> {
  const response = await fetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  const body = await readJson(response);
  if (!response.ok || typeof body['sub'] !== 'string') throw new LinkedInApiError('profile lookup', JSON.stringify(body));
  return { urn: `urn:li:person:${body['sub']}`, name: typeof body['name'] === 'string' ? body['name'] : 'LinkedIn member' };
}

const restli = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' });

/** Registers an upload and sends the picture's bytes; returns the picture's reference for the post. */
export async function uploadImage(token: string, ownerUrn: string, image: Uint8Array): Promise<string> {
  const register = await fetch(`${API}/v2/assets?action=registerUpload`, {
    method: 'POST',
    headers: { ...restli(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      registerUploadRequest: {
        recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
        owner: ownerUrn,
        serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(register);
  const value = body['value'] as { asset?: unknown; uploadMechanism?: Record<string, { uploadUrl?: unknown }> } | undefined;
  const uploadUrl = value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest']?.uploadUrl;
  if (!register.ok || typeof value?.asset !== 'string' || typeof uploadUrl !== 'string') {
    throw new LinkedInApiError('picture registration', JSON.stringify(body));
  }
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: Buffer.from(image),
    signal: AbortSignal.timeout(60_000),
  });
  if (!upload.ok) throw new LinkedInApiError('picture upload', `status ${upload.status}`);
  return value.asset;
}

export type Visibility = 'PUBLIC' | 'CONNECTIONS';

export interface LinkedInPost {
  /** "urn:li:share:<id>" */
  urn: string;
  url: string;
}

/** Posts a picture with a caption as the member. */
export async function postImage(token: string, authorUrn: string, assetUrn: string, caption: string, visibility: Visibility): Promise<LinkedInPost> {
  const response = await fetch(`${API}/v2/ugcPosts`, {
    method: 'POST',
    headers: { ...restli(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: authorUrn,
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: caption },
          shareMediaCategory: 'IMAGE',
          media: [{ status: 'READY', media: assetUrn }],
        },
      },
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': visibility },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new LinkedInApiError('post', JSON.stringify(await readJson(response)));
  const urn = response.headers.get('x-restli-id') ?? ((await readJson(response))['id'] as string | undefined);
  if (!urn) throw new LinkedInApiError('post', 'no post id in the answer');
  return { urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
}

/** The Images and Posts APIs ask for a version (YYYYMM). The environment can set another when LinkedIn retires this one. */
export const LINKEDIN_VERSION = process.env['LINKEDIN_API_VERSION'] ?? '202604';
const versioned = (token: string): Record<string, string> => ({ ...restli(token), 'Linkedin-Version': LINKEDIN_VERSION });

/** A multi-image post holds 2 to 20 pictures (LinkedIn's rule); a business post never needs more than ten. */
export const MULTI_IMAGE_MIN = 2;
export const MULTI_IMAGE_MAX = 10;

/** Uploads a picture with the Images API and answers its reference ("urn:li:image:..."), which a multi-image post needs. */
export async function uploadImageUrn(token: string, ownerUrn: string, image: Uint8Array): Promise<string> {
  const start = await fetch(`${API}/rest/images?action=initializeUpload`, {
    method: 'POST',
    headers: { ...versioned(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(start);
  const value = body['value'] as { uploadUrl?: unknown; image?: unknown } | undefined;
  if (!start.ok || typeof value?.uploadUrl !== 'string' || typeof value.image !== 'string') throw new LinkedInApiError('picture registration', JSON.stringify(body));
  const upload = await fetch(value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(image),
    signal: AbortSignal.timeout(60_000),
  });
  if (!upload.ok) throw new LinkedInApiError('picture upload', `status ${upload.status}`);
  return value.image;
}

export interface CarouselImage {
  /** "urn:li:image:..." from uploadImageUrn. */
  urn: string;
  /** What a screen reader says for it; at most 4,086 characters, under 120 is best. */
  altText?: string;
}

/** Posts several pictures as one post (the Posts API's multiImage), with the caption as the commentary. */
export async function postMultiImage(token: string, authorUrn: string, images: readonly CarouselImage[], caption: string, visibility: Visibility): Promise<LinkedInPost> {
  if (images.length < MULTI_IMAGE_MIN || images.length > MULTI_IMAGE_MAX) {
    throw new LinkedInApiError('post', `a multi-image post needs ${MULTI_IMAGE_MIN} to ${MULTI_IMAGE_MAX} pictures, not ${images.length}`);
  }
  if (images.some((i) => !i.urn.startsWith('urn:li:image:'))) throw new LinkedInApiError('post', 'every picture must be an uploaded image reference (urn:li:image:...)');
  if (images.some((i) => (i.altText ?? '').length > 4086)) throw new LinkedInApiError('post', 'a picture description is longer than 4086 characters');
  const response = await fetch(`${API}/rest/posts`, {
    method: 'POST',
    headers: { ...versioned(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      author: authorUrn,
      commentary: caption,
      visibility,
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      content: { multiImage: { images: images.map((i) => ({ id: i.urn, ...(i.altText ? { altText: i.altText } : {}) })) } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new LinkedInApiError('post', JSON.stringify(await readJson(response)));
  const urn = response.headers.get('x-restli-id');
  if (!urn) throw new LinkedInApiError('post', 'no post id in the answer');
  return { urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
}

/** Removes a post made with the Posts API (used to clean up test posts). */
export async function deleteRestPost(token: string, urn: string): Promise<void> {
  const response = await fetch(`${API}/rest/posts/${encodeURIComponent(urn)}`, {
    method: 'DELETE',
    headers: { ...versioned(token), 'X-RestLi-Method': 'DELETE' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 204) throw new LinkedInApiError('delete post', `status ${response.status}`);
}

/** Removes a post by its urn (used to clean up test posts). */
export async function deletePost(token: string, urn: string): Promise<void> {
  const response = await fetch(`${API}/v2/ugcPosts/${encodeURIComponent(urn)}`, {
    method: 'DELETE',
    headers: restli(token),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 204) throw new LinkedInApiError('delete post', `status ${response.status}`);
}

/** The poster picture's bytes, fetched from the public address the other channels also use. */
export async function fetchImage(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new LinkedInApiError('picture download', `${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Whether LinkedIn still accepts the saved token. */
export async function memberHealth(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await memberOf(token);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
