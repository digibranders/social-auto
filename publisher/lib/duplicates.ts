/**
 * Duplicate prevention at send time. A post id already stops the same post going to the same channel twice (the posted log). That does not stop the same words
 * going out twice under two different post ids, which happens when two plans, or the weekly and the daily job, both produce a post for the same day. So before a
 * post is sent to a channel, the channel's own history is checked: if a post with the same caption was sent to that channel in the last week, this one is
 * not sent, and is written down as skipped so it is never sent late either.
 */
import { createHash } from 'node:crypto';
import type { PostedEntry, PostedLog } from './channels.js';

/** How far back a channel's earlier posts are compared. */
export const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The same words with different spacing or capital letters are the same caption. */
export const normalizeCaption = (caption: string): string => caption.replace(/\s+/g, ' ').trim().toLowerCase();

/** What a post's words are remembered by in the posted log. */
export const fingerprintOf = (caption: string): string => createHash('sha256').update(normalizeCaption(caption)).digest('hex').slice(0, 32);

export interface EarlierPost {
  /** The log key of the earlier post: "<post id>|<channel id>". */
  key: string;
  entry: PostedEntry;
}

/**
 * An earlier post on this channel with the same words, sent (not skipped) within the window, other than the post itself. Entries written before fingerprints
 * existed have none and are never matched: nothing is guessed.
 */
export function findDuplicate(log: PostedLog, channelId: string, postId: string, caption: string, now: number): EarlierPost | undefined {
  const fingerprint = fingerprintOf(caption);
  const suffix = `|${channelId}`;
  for (const [key, entry] of Object.entries(log)) {
    if (!key.endsWith(suffix) || key === `${postId}${suffix}` || entry.skipped === true || entry.fingerprint !== fingerprint) continue;
    const at = Date.parse(entry.postedAt);
    if (Number.isFinite(at) && now - at < DUPLICATE_WINDOW_MS && at <= now + 60_000) return { key, entry };
  }
  return undefined;
}
