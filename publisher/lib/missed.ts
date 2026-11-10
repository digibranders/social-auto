/**
 * The missed-post notice. A post whose sending window passed without it going out on a connected channel is "missed" in the dashboard; this finds those
 * and tells the owner once each, so a missed post is not discovered only by looking at the calendar. It reads what the publisher already knows (the schedule,
 * the connected channels, the log of what was posted and the pauses) and writes only the list of notices already sent.
 *
 * Scope: channels that keep a record in the posted log (Facebook, LinkedIn, Google Business and a customer's own Instagram account). A post on the team's own
 * Instagram is checked against Instagram itself by the status feed, so it is not decided here; its failures are already announced when sending fails.
 */
import type { ChannelFile, PostedLog } from './channels.js';
import { crosspostStatusFor } from './crosspost.js';
import { brandIsPaused, isPaused, type PauseFile } from './pauses.js';
import type { ScheduledPost } from './schedule.js';

/** A missed post is announced only while it is this recent, so an old backlog never floods the phone. */
export const MISSED_REPORT_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;
const KEEP_DAYS = 60;

export interface MissedPost {
  /** What the notice is remembered by: the post and the channel. */
  key: string;
  postId: string;
  brand: string;
  date: string;
  /** The channel's id, and how a person knows it. */
  channelId: string;
  account: string;
}

/** The notices already sent: the key of each, and when. */
export interface AlertLog {
  missed: Record<string, string>;
}

export const NO_ALERTS: AlertLog = { missed: {} };

/** Reads the notice log, refusing anything that is not the expected shape rather than guessing. */
export function parseAlertLog(raw: unknown): AlertLog {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('alerts.json must be an object');
  const missed = (raw as Record<string, unknown>)['missed'];
  if (missed === undefined) return NO_ALERTS;
  if (typeof missed !== 'object' || missed === null || Array.isArray(missed)) throw new Error('alerts.json "missed" must be an object');
  for (const [key, at] of Object.entries(missed)) if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new Error(`alerts.json "missed" has a bad time for ${key}`);
  return { missed: { ...(missed as Record<string, string>) } };
}

/** The posts that were meant for a channel, whose sending window passed in the last MISSED_REPORT_HOURS hours, and that did not go out. A paused client or channel is held on purpose, so it is not reported. */
export function findMissed(posts: readonly ScheduledPost[], channels: ChannelFile, log: PostedLog, pauses: PauseFile, now: number): MissedPost[] {
  const out: MissedPost[] = [];
  for (const post of posts) {
    const at = Date.parse(post.date);
    if (post.skipped === true || at > now || now - at >= MISSED_REPORT_HOURS * HOUR_MS) continue;
    const brand = post.brand ?? 'default';
    if (brandIsPaused(pauses, brand)) continue;
    for (const status of crosspostStatusFor(post, channels, log, now, pauses)) {
      if (status.state !== 'missed' || isPaused(pauses, brand, status.id)) continue;
      out.push({ key: `${post.id}|${status.id}`, postId: post.id, brand, date: post.date, channelId: status.id, account: status.account });
    }
  }
  return out;
}

/** The missed posts not announced before. Pure: the caller sends the notices, then saves the log with `withAnnounced`. */
export function unannounced(missed: readonly MissedPost[], sent: AlertLog): MissedPost[] {
  return missed.filter((m) => sent.missed[m.key] === undefined);
}

/** The log with these posts added as announced at `now`, and entries older than KEEP_DAYS forgotten. */
export function withAnnounced(sent: AlertLog, announced: readonly MissedPost[], now: number): AlertLog {
  const cutoff = now - KEEP_DAYS * 24 * HOUR_MS;
  const kept = Object.fromEntries(Object.entries(sent.missed).filter(([, at]) => Date.parse(at) > cutoff));
  for (const m of announced) kept[m.key] = new Date(now).toISOString();
  return { missed: kept };
}

/** The phone message for one client's missed posts, grouped so a bad day sends one message per client, not one per post and channel. */
export function missedMessage(brand: string, missed: readonly MissedPost[]): { title: string; message: string } {
  const lines = missed.map((m) => `${m.date.slice(0, 16).replace('T', ' ')}: ${m.account}`);
  const shown = lines.slice(0, 8).join('\n');
  const more = lines.length > 8 ? `\nand ${lines.length - 8} more` : '';
  return {
    title: missed.length === 1 ? `A post was missed: ${brand}` : `${missed.length} posts were missed: ${brand}`,
    message: `${brand}:\n${shown}${more}\n\nThese were not posted in their time window and will not go out by themselves. See the calendar in the dashboard to move or re-send them.`,
  };
}
