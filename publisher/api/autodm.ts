/**
 * Manage keyword-triggered Instagram Auto-DM rules. Called only by the dashboard server (EDIT_SECRET).
 *
 * GET    /api/autodm?brand=<slug>
 * POST   /api/autodm                {"brand": "...", "keyword": "...", "message": "...", "mediaId"?: "..."}
 * PATCH  /api/autodm                {"id": "...", "keyword"?: "...", "message"?: "...", "mediaId"?: "...", "enabled"?: boolean}
 * DELETE /api/autodm?id=<uuid>
 */
import { addAutoDmRule, deleteAutoDmRule, updateAutoDmRule } from '../lib/autodm.js';
import type { InstagramChannel } from '../lib/channels.js';
import { allBrands } from '../lib/clients.js';
import { decrypt, parseKey } from '../lib/crypto.js';
import { describeError, isAuthorized, json } from '../lib/http.js';
import { recentMedia, subscribeAccountWebhooks, type RecentMedia } from '../lib/instagram.js';
import { EditError } from '../lib/overrides.js';
import { parseSchedule } from '../lib/schedule.js';
import { scheduleData } from '../lib/schedule-source.js';
import { loadAutoDm, loadChannels, loadClients, saveAutoDm, storeConfigured } from '../lib/store.js';

const MAX_BODY_BYTES = 8 * 1024;
const plannedBrands = (): string[] => parseSchedule(scheduleData).map((p) => p.brand ?? 'default');

function unauthorizedOrUnconfigured(request: Request): Response | null {
  if (!isAuthorized(request, process.env['EDIT_SECRET'])) return json(401, { error: 'unauthorized' });
  if (!storeConfigured()) return json(503, { error: 'storage is not set up' });
  return null;
}

async function ensureSubscribed(brand: string): Promise<void> {
  try {
    const { file: channelsFile } = await loadChannels();
    const ig = channelsFile.channels.find((c): c is InstagramChannel => c.platform === 'instagram' && c.brand === brand);
    if (ig) {
      await subscribeAccountWebhooks(ig.userId, decrypt(ig.token, parseKey(process.env['CHANNEL_KEY'])));
    }
  } catch (error) {
    console.error(`Instagram webhook subscription failed for ${brand}: ${describeError(error)}`);
  }
}

export async function GET(request: Request): Promise<Response> {
  const denied = unauthorizedOrUnconfigured(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const brand = params.get('brand');
  const includePosts = params.get('posts') === '1';
  const { file } = await loadAutoDm();
  const rules = brand ? file.rules.filter((r) => r.brand === brand) : file.rules;
  if (!includePosts || !brand) return json(200, { rules });

  let posts: RecentMedia[] = [];
  let postsError: string | undefined;
  try {
    const { file: channelsFile } = await loadChannels();
    const ig = channelsFile.channels.find((c): c is InstagramChannel => c.platform === 'instagram' && c.brand === brand);
    if (ig) {
      const key = parseKey(process.env['CHANNEL_KEY']);
      posts = await recentMedia(ig.userId, decrypt(ig.token, key), 25);
    }
  } catch (error) {
    postsError = describeError(error);
  }
  return json(200, { rules, posts, ...(postsError ? { postsError } : {}) });
}

export async function POST(request: Request): Promise<Response> {
  const denied = unauthorizedOrUnconfigured(request);
  if (denied) return denied;
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const brand = typeof body?.['brand'] === 'string' ? body['brand'].trim() : '';
  if (!brand) return json(400, { error: 'brand is required' });
  const known = allBrands(plannedBrands(), (await loadClients()).file);
  if (!known.has(brand)) return json(400, { error: `unknown client "${brand}"` });

  try {
    const { file, etag } = await loadAutoDm();
    const { file: next, rule } = addAutoDmRule(
      file,
      brand,
      {
        keyword: typeof body?.['keyword'] === 'string' ? body['keyword'] : '',
        message: typeof body?.['message'] === 'string' ? body['message'] : '',
        ...(typeof body?.['mediaId'] === 'string' ? { mediaId: body['mediaId'] } : {}),
        ...(typeof body?.['requireFollow'] === 'boolean' ? { requireFollow: body['requireFollow'] } : {}),
        ...(typeof body?.['enabled'] === 'boolean' ? { enabled: body['enabled'] } : {}),
      },
      Date.now(),
    );
    await saveAutoDm(next, etag);
    await ensureSubscribed(brand);
    return json(200, { rule });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    if (error instanceof Error) return json(400, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not save Auto-DM rule' });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  const denied = unauthorizedOrUnconfigured(request);
  if (denied) return denied;
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'request too large' });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.['id'] === 'string' ? body['id'].trim() : '';
  if (!id) return json(400, { error: 'id is required' });

  try {
    const { file, etag } = await loadAutoDm();
    const { file: next, rule } = updateAutoDmRule(
      file,
      id,
      {
        keyword: body?.['keyword'],
        message: body?.['message'],
        mediaId: body?.['mediaId'],
        requireFollow: body?.['requireFollow'],
        enabled: body?.['enabled'],
      },
      Date.now(),
    );
    await saveAutoDm(next, etag);
    await ensureSubscribed(rule.brand);
    return json(200, { rule });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    if (error instanceof Error) return json(error.message.includes('not found') ? 404 : 400, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not update Auto-DM rule' });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const denied = unauthorizedOrUnconfigured(request);
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get('id')?.trim() ?? '';
  if (!id) return json(400, { error: 'id is required' });

  try {
    const { file, etag } = await loadAutoDm();
    const { file: next, removed } = deleteAutoDmRule(file, id);
    if (!removed) return json(404, { error: 'Auto-DM rule not found' });
    await saveAutoDm(next, etag);
    return json(200, { ok: true });
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    console.error(describeError(error));
    return json(500, { error: 'could not delete Auto-DM rule' });
  }
}
