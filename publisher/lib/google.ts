/**
 * Minimal Google Business Profile client for posting an update (a "local post") with a picture.
 * A connection keeps Google's refresh token; each use swaps it for a one-hour access token.
 */

/** Google's addresses. The environment can point them at a pretend Google for local testing (see dev/fake-google.ts). */
const AUTHORIZE = process.env['GOOGLE_AUTHORIZE_URL'] ?? 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = process.env['GOOGLE_TOKEN_URL'] ?? 'https://oauth2.googleapis.com/token';
const ACCOUNTS_API = process.env['GOOGLE_API_URL'] ?? 'https://mybusinessaccountmanagement.googleapis.com';
const INFO_API = process.env['GOOGLE_API_URL'] ?? 'https://mybusinessbusinessinformation.googleapis.com';
const POSTS_API = process.env['GOOGLE_API_URL'] ?? 'https://mybusiness.googleapis.com';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/business.manage';
/** Google refuses an update summary longer than this. */
export const MAX_SUMMARY = 1500;
/** More locations than this on one account is far beyond one client; stop listing. */
const MAX_LOCATIONS = 100;

export class GoogleApiError extends Error {
  constructor(step: string, detail: string) {
    super(`Google ${step} failed: ${detail.slice(0, 400)}`);
    this.name = 'GoogleApiError';
  }
}

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
}

export function authorizeUrl(options: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    state: options.state,
    scope: GOOGLE_SCOPE,
    // Offline access plus a consent screen every time is what makes Google return a refresh token.
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${AUTHORIZE}?${params}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
}

const reasonOf = (body: Record<string, unknown>): string => {
  const error = body['error'];
  if (typeof error === 'object' && error !== null) return String((error as Record<string, unknown>)['message'] ?? JSON.stringify(error));
  return String(body['error_description'] ? `${String(error)}: ${String(body['error_description'])}` : (error ?? JSON.stringify(body)));
};

async function tokenRequest(app: GoogleApp, step: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, ...fields }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok || typeof body['access_token'] !== 'string') throw new GoogleApiError(step, reasonOf(body));
  return body;
}

export interface GoogleTokens {
  /** Secret: never print or log either token. */
  accessToken: string;
  refreshToken: string;
}

/** Swaps the one-time code from the redirect for tokens. Secrets go in the body, never the address. */
export async function exchangeCode(app: GoogleApp, redirectUri: string, code: string): Promise<GoogleTokens> {
  const body = await tokenRequest(app, 'code exchange', { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (typeof body['refresh_token'] !== 'string') {
    throw new GoogleApiError(
      'code exchange',
      'Google sent no refresh token. Remove the app under the Google account’s third-party access, then connect again.',
    );
  }
  return { accessToken: body['access_token'] as string, refreshToken: body['refresh_token'] };
}

/** A fresh one-hour access token from the saved refresh token. */
export async function accessTokenFor(app: GoogleApp, refreshToken: string): Promise<string> {
  try {
    return (await tokenRequest(app, 'sign-in refresh', { grant_type: 'refresh_token', refresh_token: refreshToken }))['access_token'] as string;
  } catch (error) {
    if (error instanceof GoogleApiError && /invalid_grant/.test(error.message)) {
      throw new GoogleApiError('sign-in refresh', 'access was withdrawn or expired. Connect Google again from the dashboard.');
    }
    throw error;
  }
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

async function getJson(url: string, token: string, step: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: bearer(token), signal: AbortSignal.timeout(30_000) });
  const body = await readJson(response);
  if (!response.ok) throw new GoogleApiError(step, reasonOf(body));
  return body;
}

export interface GoogleLocation {
  /** "accounts/<id>" */
  account: string;
  /** "locations/<id>" */
  location: string;
  title: string;
}

/** Every business location the signed-in account may post for. */
export async function listLocations(accessToken: string): Promise<GoogleLocation[]> {
  const accounts = await getJson(`${ACCOUNTS_API}/v1/accounts?pageSize=20`, accessToken, 'account list');
  const found: GoogleLocation[] = [];
  for (const account of (accounts['accounts'] as Array<{ name?: unknown }> | undefined) ?? []) {
    if (typeof account.name !== 'string') continue;
    const query = new URLSearchParams({ readMask: 'name,title', pageSize: '100' });
    const body = await getJson(`${INFO_API}/v1/${account.name}/locations?${query}`, accessToken, 'location list');
    for (const location of (body['locations'] as Array<{ name?: unknown; title?: unknown }> | undefined) ?? []) {
      if (typeof location.name === 'string') found.push({ account: account.name, location: location.name, title: typeof location.title === 'string' ? location.title : location.name });
    }
    if (found.length >= MAX_LOCATIONS) break;
  }
  return found.slice(0, MAX_LOCATIONS);
}

export interface GooglePost {
  /** "accounts/<id>/locations/<id>/localPosts/<id>" */
  name: string;
  /** A Google Search address for the business where the update appears, if Google gave one. */
  url: string | null;
}

/** Publishes an update with one picture. Google downloads the picture from `imageUrl`, so it must be public. */
export async function createPost(
  accessToken: string,
  account: string,
  location: string,
  update: { summary: string; imageUrl: string },
): Promise<GooglePost> {
  const response = await fetch(`${POSTS_API}/v4/${account}/${location}/localPosts`, {
    method: 'POST',
    headers: { ...bearer(accessToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      languageCode: 'en',
      summary: update.summary,
      topicType: 'STANDARD',
      media: [{ mediaFormat: 'PHOTO', sourceUrl: update.imageUrl }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJson(response);
  if (!response.ok) throw new GoogleApiError('post', reasonOf(body));
  if (typeof body['name'] !== 'string') throw new GoogleApiError('post', 'no post name in the answer');
  return { name: body['name'], url: typeof body['searchUrl'] === 'string' ? body['searchUrl'] : null };
}

/** Removes an update by its name (used to clean up test posts). */
export async function deletePost(accessToken: string, name: string): Promise<void> {
  const response = await fetch(`${POSTS_API}/v4/${name}`, { method: 'DELETE', headers: bearer(accessToken), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new GoogleApiError('delete post', `status ${response.status}`);
}

/**
 * The caption as a Google update: hashtags do nothing there, so they go, and the text is cut at a word
 * boundary to fit the limit.
 */
export function googleSummary(caption: string): string {
  const text = caption
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= MAX_SUMMARY) return text;
  const cut = text.slice(0, MAX_SUMMARY - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : cut.length).trimEnd()}…`;
}

/** Whether the saved refresh token still works. */
export async function locationHealth(app: GoogleApp, refreshToken: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await accessTokenFor(app, refreshToken);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
