/**
 * Private status feed for the dashboard: every scheduled post with where it stands (including edits made in
 * the dashboard), plus the Instagram connection's health. The Instagram token stays here; the dashboard only
 * holds the separate STATUS_SECRET.
 *
 * GET /api/status   (Authorization: Bearer $STATUS_SECRET)
 */
import { schedule as scheduleData } from '../data/schedule.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import { parseKey } from '../lib/crypto.js';
import { facebookStatusFor } from '../lib/crosspost.js';
import { channelToken, type ChannelFile } from '../lib/channels.js';
import { pageHealth } from '../lib/facebook.js';
import { accountProfile, mediaSince, type AccountMedia, type AccountProfile } from '../lib/instagram.js';
import { applyOverrides } from '../lib/overrides.js';
import { buildStatus, parseSchedule } from '../lib/schedule.js';
import { loadChannels, loadOverrides, loadPosted } from '../lib/store.js';

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

/** Page checks are remembered for a minute per saved token, so a newly connected Page is checked at once. */
const facebookCache = new Map<string, { at: number; health: Health }>();

async function lookUpFacebook(channels: ChannelFile, now: number): Promise<Record<string, Health>> {
  let key: Buffer | null = null;
  let keyProblem: string | null = null;
  try {
    key = parseKey(process.env['CHANNEL_KEY']);
  } catch (error) {
    keyProblem = describeError(error);
  }
  const result: Record<string, Health> = {};
  await Promise.all(
    channels.channels.map(async (channel) => {
      const cacheKey = `${channel.id}|${channel.token}`;
      const cached = facebookCache.get(cacheKey);
      if (cached && now - cached.at < CACHE_MS) {
        result[channel.id] = cached.health;
        return;
      }
      let health: Health;
      try {
        health = key ? await pageHealth(channel.pageId, channelToken(channel, key)) : { ok: false, error: keyProblem ?? 'no key' };
      } catch (error) {
        health = { ok: false, error: describeError(error) };
      }
      facebookCache.set(cacheKey, { at: now, health });
      result[channel.id] = health;
    }),
  );
  return result;
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
    const [{ overrides }, { file: channels }, { log: posted }] = await Promise.all([loadOverrides(), loadChannels(), loadPosted()]);
    const posts = applyOverrides(parseSchedule(scheduleData), overrides);

    if (!cache || now - cache.at >= CACHE_MS) {
      const earliest = posts.length ? Math.min(...posts.map((p) => Date.parse(p.date))) : now;
      cache = { at: now, view: await lookUpInstagram(earliest) };
    }
    const { media, profile, health } = cache.view;

    // One Instagram account carries every client for now; a second account would need its own entry here.
    const brands = [...new Set(posts.map((p) => p.brand ?? 'default'))];
    const facebookHealth = await lookUpFacebook(channels, now);
    const summary = buildStatus(posts, media, now, origin);
    return json(200, {
      generatedAt: new Date(now).toISOString(),
      channels: [
        { platform: 'instagram', account: profile.username, avatar: profile.pictureUrl, brands, ...health },
        ...channels.channels.map((channel) => ({
          platform: channel.platform,
          account: channel.pageName,
          avatar: null,
          brands: [channel.brand],
          ...(facebookHealth[channel.id] ?? { ok: false, error: 'not checked' }),
        })),
      ],
      ...summary,
      posts: summary.posts.map((p) => ({ ...p, crossposts: facebookStatusFor(p, channels, posted, now) })),
    });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'status is unavailable' });
  }
}
