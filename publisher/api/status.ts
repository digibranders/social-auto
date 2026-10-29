/**
 * Private status feed for the dashboard: every scheduled post with where it stands, plus the
 * Instagram connection's health. Read-only. The Instagram token stays here; the dashboard only
 * holds the separate STATUS_SECRET.
 *
 * GET /api/status   (Authorization: Bearer $STATUS_SECRET)
 */
import { schedule as scheduleData } from '../data/schedule.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import { accountProfile, mediaSince, type AccountMedia, type AccountProfile } from '../lib/instagram.js';
import { buildStatus, parseSchedule } from '../lib/schedule.js';

/** Instagram is asked at most once a minute per warm function instance, however many people look. */
const CACHE_MS = 60_000;
/** Look this far before the first scheduled post so a post published a little early still matches. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface Health {
  ok: boolean;
  error?: string;
}

let cache: { at: number; body: Record<string, unknown> } | null = null;

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['STATUS_SECRET'])) return json(401, { error: 'unauthorized' });

  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return json(200, cache.body);

  const posts = parseSchedule(scheduleData);
  const origin = process.env['PUBLIC_ORIGIN'] ?? new URL(request.url).origin;

  let media: AccountMedia[] | null = null;
  let profile: AccountProfile = { username: null, pictureUrl: null };
  const health: Health = { ok: true };
  try {
    const token = requireEnv('INSTAGRAM_TOKEN');
    const userId = requireEnv('INSTAGRAM_USER_ID');
    const earliest = posts.length ? Math.min(...posts.map((p) => Date.parse(p.date))) : now;
    [media, profile] = await Promise.all([mediaSince(userId, token, earliest - LOOKBACK_MS), accountProfile(token)]);
  } catch (error) {
    health.ok = false;
    health.error = describeError(error);
  }

  // One Instagram account carries every client for now; a second account would need its own entry here.
  const brands = [...new Set(posts.map((p) => p.brand ?? 'default'))];
  const body = {
    generatedAt: new Date(now).toISOString(),
    channels: [{ platform: 'instagram', account: profile.username, avatar: profile.pictureUrl, brands, ...health }],
    ...buildStatus(posts, media, now, origin),
  };
  cache = { at: now, body };
  return json(200, body);
}
