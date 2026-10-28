/** Minimal Instagram Graph API client (Instagram API with Instagram Login). */

const GRAPH = 'https://graph.instagram.com/v23.0';
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
