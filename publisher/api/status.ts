/**
 * Private status feed for the dashboard: every scheduled post with where it stands (including edits made in
 * the dashboard), plus the Instagram connection's health. The Instagram token stays here; the dashboard only
 * holds the separate STATUS_SECRET.
 *
 * GET /api/status   (Authorization: Bearer $STATUS_SECRET)
 */
import { scheduleData } from '../lib/schedule-source.js';
import { describeError, isAuthorized, json, requireEnv } from '../lib/http.js';
import { parseKey } from '../lib/crypto.js';
import { crosspostStatusFor } from '../lib/crosspost.js';
import { channelLabel, channelToken, type ChannelFile, type PostedLog } from '../lib/channels.js';
import { pageHealth } from '../lib/facebook.js';
import { locationHealth } from '../lib/google.js';
import { memberHealth } from '../lib/linkedin.js';
import { accountProfile, mediaSince, tokenHealth, type AccountMedia, type AccountProfile } from '../lib/instagram.js';
import { applyOverrides } from '../lib/overrides.js';
import { toScheduled } from '../lib/manual.js';
import { brandIsPaused, isPaused, type PauseFile } from '../lib/pauses.js';
import { buildStatus, isWantedOn, parseSchedule, type StatusPost } from '../lib/schedule.js';
import { loadCosts } from '../lib/usage.js';
import { clientFeedDetails } from '../lib/clients.js';
import { loadChannels, loadClients, loadManual, loadOverrides, loadPauses, loadPosted } from '../lib/store.js';

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

/** Page and profile checks are remembered for a minute per saved token, so a newly connected Page is checked at once. */
const channelCache = new Map<string, { at: number; health: Health }>();

async function lookUpChannels(channels: ChannelFile, now: number): Promise<Record<string, Health>> {
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
      const cached = channelCache.get(cacheKey);
      if (cached && now - cached.at < CACHE_MS) {
        result[channel.id] = cached.health;
        return;
      }
      let health: Health;
      try {
        if (!key) health = { ok: false, error: keyProblem ?? 'no key' };
        else if (channel.platform === 'facebook') health = await pageHealth(channel.pageId, channelToken(channel, key));
        else if (channel.platform === 'google') health = await locationHealth({ clientId: requireEnv('GOOGLE_CLIENT_ID'), clientSecret: requireEnv('GOOGLE_CLIENT_SECRET') }, channelToken(channel, key));
        else if (Date.parse(channel.expiresAt) <= now) health = { ok: false, error: `The ${channel.platform === 'linkedin' ? 'LinkedIn' : 'Instagram'} connection has expired. They need to connect again.` };
        else if (channel.platform === 'linkedin') health = await memberHealth(channelToken(channel, key));
        else health = await tokenHealth(channelToken(channel, key));
      } catch (error) {
        health = { ok: false, error: describeError(error) };
      }
      channelCache.set(cacheKey, { at: now, health });
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

/** Adds each channel's status. A hand-made post that skips Instagram takes its state and look from the channels it does go to. */
function withCrossposts(post: StatusPost, channels: ChannelFile, posted: PostedLog, now: number, pauses: PauseFile): StatusPost {
  const crossposts = crosspostStatusFor({ ...post, skipped: post.state === 'skipped', channels: post.channels ?? undefined }, channels, posted, now, pauses);
  if (post.channels === null || post.channels.includes('instagram') || crossposts.length === 0) return { ...post, crossposts };
  const first = crossposts[0] as (typeof crossposts)[number];
  const pending = crossposts.find((c) => c.state !== 'published');
  return {
    ...post,
    platform: first.platform,
    state: post.state === 'skipped' ? 'skipped' : pending ? pending.state : 'published',
    permalink: first.permalink,
    crossposts,
  };
}

/**
 * A post that is still to go out shows as paused when its client is paused, or when every place it goes to is: the team's own Instagram
 * (when it is meant for it) and each connected channel. A post that goes somewhere that is not paused is not shown as paused.
 */
function withPauses(post: StatusPost, pauses: PauseFile): StatusPost {
  if (post.state !== 'scheduled' && post.state !== 'due') return post;
  const targets = [...(isWantedOn({ channels: post.channels ?? undefined }, 'instagram') ? [isPaused(pauses, post.brand, 'instagram')] : []), ...post.crossposts.map((c) => c.state === 'paused')];
  const held = brandIsPaused(pauses, post.brand) || (targets.length > 0 && targets.every(Boolean));
  return held ? { ...post, state: 'paused', editable: Date.parse(post.date) > Date.now() } : post;
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorized(request, process.env['STATUS_SECRET'])) return json(401, { error: 'unauthorized' });

  const now = Date.now();
  const origin = process.env['PUBLIC_ORIGIN'] ?? new URL(request.url).origin;

  try {
    const [{ overrides }, { file: channels }, { log: posted }, { file: manual }, { file: added }, { file: pauses }] = await Promise.all([loadOverrides(), loadChannels(), loadPosted(), loadManual(), loadClients(), loadPauses()]);
    const posts = applyOverrides([...parseSchedule(scheduleData), ...manual.posts.map(toScheduled)], overrides);

    if (!cache || now - cache.at >= CACHE_MS) {
      const earliest = posts.length ? Math.min(...posts.map((p) => Date.parse(p.date))) : now;
      cache = { at: now, view: await lookUpInstagram(earliest) };
    }
    const { media, profile, health } = cache.view;

    // One Instagram account carries every client for now; a second account would need its own entry here.
    const brands = [...new Set(posts.map((p) => p.brand ?? 'default'))];
    const channelHealth = await lookUpChannels(channels, now);
    const summary = buildStatus(posts, media, now, origin);
    return json(200, {
      generatedAt: new Date(now).toISOString(),
      pauses,
      channels: [
        { id: null, platform: 'instagram', account: profile.username, avatar: profile.pictureUrl, brands, paused: pauses.channels.includes('instagram'), ...health },
        ...channels.channels.map((channel) => ({
          id: channel.id,
          platform: channel.platform,
          account: channelLabel(channel),
          avatar: null,
          brands: [channel.brand],
          paused: isPaused(pauses, channel.brand, channel.id),
          ...(channel.platform === 'linkedin' || channel.platform === 'instagram' ? { expiresAt: channel.expiresAt } : {}),
          ...(channelHealth[channel.id] ?? { ok: false, error: 'not checked' }),
        })),
      ],
      ...summary,
      runway: [
        // A client added in the dashboard that already has posts on the calendar keeps its plans, limit and settings: they are not lost because posts exist.
        ...summary.runway.map((r) => { const c = added.clients.find((a) => a.brand === r.brand); return c ? { ...r, ...clientFeedDetails(c) } : r; }),
        ...added.clients.filter((c) => !summary.runway.some((r) => r.brand === c.brand)).map((c) => ({ brand: c.brand, postsLeft: 0, added: true as const, ...clientFeedDetails(c) })),
      ],
      posts: summary.posts.map((p) => withPauses(withCrossposts(p, channels, posted, now, pauses), pauses)),
      // The cost view is a nicety: if its log is unreadable the rest of the status must still load.
      costs: await loadCosts(process.env['USAGE_LOG_FILE']).catch((error: unknown) => {
        console.error(describeError(error));
        return [];
      }),
    });
  } catch (error) {
    console.error(describeError(error));
    return json(500, { error: 'status is unavailable' });
  }
}
