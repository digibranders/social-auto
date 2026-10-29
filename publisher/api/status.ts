/**
 * Private status feed for the dashboard: every scheduled post with where it stands (including edits made in
 * the dashboard), plus the Instagram connection's health. The Instagram token stays here; the dashboard only
 * holds the separate STATUS_SECRET.
 *
 * GET /api/status   (Authorization: Bearer $STATUS_SECRET)
 */
import { schedule as scheduleData } from '../data/schedule.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import { accountProfile, mediaSince, type AccountMedia, type AccountProfile } from '../lib/instagram.js';
import { applyOverrides } from '../lib/overrides.js';
import { buildStatus, parseSchedule } from '../lib/schedule.js';
import { loadOverrides } from '../lib/store.js';

/** Instagram is asked at most once a minute per warm function instance, however many people look. */
const CACHE_MS = 60_000;
/** Look this far before the first scheduled post so a post published a little early still matches. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface Health {
  ok: boolean;
  error?: string;
}

interface InstagramView {
  media: AccountMedia[] | null;
  profile: AccountProfile;
  health: Health;
}

/** Only Instagram's answer is cached: edits are read fresh, so a saved change shows up at once. */
let cache: { at: number; view: InstagramView } | null = null;

async function lookUpInstagram(earliest: number): Promise<InstagramView> {
  try {
    const token = requireEnv('INSTAGRAM_TOKEN');
    const userId = requireEnv('INSTAGRAM_USER_ID');
    const [media, profile] = await Promise.all([mediaSince(userId, token, earliest - LOOKBACK_MS), accountProfile(token)]);
    return { media, profile, health: { ok: true } };
  } catch (error) {
    return {
      media: null,
      profile: { username: null, pictureUrl: null },
      health: { ok: false, error: describeError(error) },
    };
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['STATUS_SECRET'])) return json(401, { error: 'unauthorized' });

  const now = Date.now();
  const origin = process.env['PUBLIC_ORIGIN'] ?? new URL(request.url).origin;

  try {
    const { overrides } = await loadOverrides();
    const posts = applyOverrides(parseSchedule(scheduleData), overrides);

    if (!cache || now - cache.at >= CACHE_MS) {
      const earliest = posts.length ? Math.min(...posts.map((p) => Date.parse(p.date))) : now;
      cache = { at: now, view: await lookUpInstagram(earliest) };
    }
    const { media, profile, health } = cache.view;

    // One Instagram account carries every client for now; a second account would need its own entry here.
    const brands = [...new Set(posts.map((p) => p.brand ?? 'default'))];
    return json(200, {
      generatedAt: new Date(now).toISOString(),
      channels: [{ platform: 'instagram', account: profile.username, avatar: profile.pictureUrl, brands, ...health }],
      ...buildStatus(posts, media, now, origin),
    });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'status is unavailable' });
  }
}
