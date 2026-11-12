/**
 * The team's own Instagram account: set in the server's settings, not connected as a channel, and serving several clients. This finds its posts from the
 * account itself and says which client each belongs to, for the analytics and the inbox checks.
 */
import type { TeamInstagram } from './analytics-collect.js';
import { mediaSince } from './instagram.js';
import { toScheduled } from './manual.js';
import { parseSchedule, sameCaption } from './schedule.js';
import { scheduleData } from './schedule-source.js';
import { loadManual } from './store.js';
import { forPlatform } from './variants.js';

/** How far back the team account's own posts are looked at. */
const WATCH_BACK_MS = 30 * 86_400_000;

/** The team's own Instagram account, when its settings are there, and which client each of its posts belongs to. */
export async function teamInstagram(): Promise<TeamInstagram | null> {
  const token = process.env['INSTAGRAM_TOKEN'];
  const userId = process.env['INSTAGRAM_USER_ID'];
  if (!token || !userId) return null;
  const { file: manual } = await loadManual();
  const posts = [...parseSchedule(scheduleData), ...manual.posts.map(toScheduled)];
  const brands = new Map(posts.map((p) => [p.id, p.brand ?? 'default'] as const));
  return {
    userId,
    token,
    brandOfPost: (postId) => brands.get(postId),
    discover: async (now) => {
      const media = await mediaSince(userId, token, now - WATCH_BACK_MS);
      return media.flatMap((m) => {
        const post = posts.find((p) => sameCaption(m.caption, forPlatform(p, 'instagram').caption));
        return post ? [{ postId: post.id, remoteId: m.id, permalink: m.permalink || null, postedAt: m.timestamp }] : [];
      });
    },
  };
}

