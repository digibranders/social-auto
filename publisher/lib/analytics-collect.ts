/**
 * The daily check: asks each connected account and each recent post for its numbers and adds one more day to the saved series.
 *
 * Nothing is written to a network. A post or account that fails is reported and skipped; the others carry on.
 */
import { EMPTY_ANALYTICS, dayOf, hashtagsOf, keepChannels, recordAccount, recordPost, CAPTION_KEEP, type AnalyticsFile, type AnalyticsPlatform } from './analytics.js';
import type { AccountReading, PostReading } from './analytics-fetch.js';
import { channelLabel, channelToken, type Channel, type PostedLog } from './channels.js';
import type { GoogleApp } from './google.js';

export interface AnalyticsReaders {
  instagramPost(mediaId: string, token: string): Promise<PostReading>;
  instagramAccount(userId: string, token: string, today: string): Promise<AccountReading>;
  facebookPost(postId: string, token: string): Promise<PostReading>;
  facebookAccount(pageId: string, token: string, today: string): Promise<AccountReading>;
  googleToken(app: GoogleApp, refreshToken: string): Promise<string>;
  googleLocation(location: string, accessToken: string, since: string, until: string): Promise<AccountReading>;
}

/** Posts older than this are no longer asked about. */
export const POST_WATCH_DAYS = 60;
/** A post is asked about every day for its first week, then once a week. */
const DAILY_DAYS = 7;
const GOOGLE_BACK_DAYS = 14;
const DAY_MS = 86_400_000;

export interface CollectReport {
  posts: number;
  accounts: number;
  failures: Array<{ id: string; reason: string }>;
}

export interface CollectInput {
  file: AnalyticsFile;
  channels: readonly Channel[];
  posted: PostedLog;
  key: Buffer;
  googleApp: GoogleApp | null;
  readers: AnalyticsReaders;
  now: number;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** A log entry that is a real post on the network (not held, repeated or dropped because the account was gone). */
const isSent = (entry: PostedLog[string]): boolean => entry.skipped !== true && entry.duplicateOf === undefined && entry.reason === undefined && entry.remoteId !== '' && !['held', 'duplicate', 'account-disconnected'].includes(entry.remoteId);

function postIsDue(lastDay: string | undefined, postedMs: number, now: number): boolean {
  const today = dayOf(now);
  if (lastDay === undefined) return true;
  if (lastDay >= today) return false;
  if (now - postedMs <= DAILY_DAYS * DAY_MS) return true;
  return Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`) >= 7 * DAY_MS;
}

export async function collectAnalytics(input: CollectInput): Promise<{ file: AnalyticsFile; report: CollectReport }> {
  const { channels, posted, key, googleApp, readers, now } = input;
  const today = dayOf(now);
  const report: CollectReport = { posts: 0, accounts: 0, failures: [] };
  const byId = new Map(channels.map((c) => [c.id, c] as const));
  let file = keepChannels(input.file ?? EMPTY_ANALYTICS, new Set(byId.keys()));

  for (const channel of channels) {
    const prior = file.accounts[channel.id];
    if (prior && prior.checkedAt.slice(0, 10) === today) continue;
    try {
      let reading: AccountReading;
      if (channel.platform === 'instagram') reading = await readers.instagramAccount(channel.userId, channelToken(channel, key), today);
      else if (channel.platform === 'facebook') reading = await readers.facebookAccount(channel.pageId, channelToken(channel, key), today);
      else if (channel.platform === 'google') {
        if (!googleApp) throw new Error('Google is not set up on this server');
        const accessToken = await readers.googleToken(googleApp, channelToken(channel, key));
        reading = await readers.googleLocation(channel.location, accessToken, dayOf(now - GOOGLE_BACK_DAYS * DAY_MS), dayOf(now - DAY_MS));
      } else continue;
      file = recordAccount(
        file,
        channel.id,
        {
          brand: channel.brand,
          channel: channel.id,
          platform: channel.platform,
          label: channelLabel(channel),
          ...(reading.audience ? { audience: reading.audience } : prior?.audience ? { audience: prior.audience } : {}),
          ...(reading.searchTerms ? { searchTerms: reading.searchTerms } : prior?.searchTerms ? { searchTerms: prior.searchTerms } : {}),
          ...(reading.needs.length > 0 ? { needs: reading.needs } : {}),
          checkedAt: new Date(now).toISOString(),
        },
        reading.numbers,
        now,
      );
      report.accounts += 1;
    } catch (error) {
      report.failures.push({ id: channel.id, reason: reasonOf(error) });
    }
  }

  for (const [logKey, entry] of Object.entries(posted)) {
    const channelId = logKey.slice(logKey.lastIndexOf('|') + 1);
    const channel = byId.get(channelId);
    if (!channel || (channel.platform !== 'instagram' && channel.platform !== 'facebook') || !isSent(entry)) continue;
    const postedMs = Date.parse(entry.postedAt);
    if (Number.isNaN(postedMs) || now - postedMs > POST_WATCH_DAYS * DAY_MS) continue;
    const before = file.posts[logKey];
    const lastDay = before ? Object.keys(before.series).sort().pop() : undefined;
    if (!postIsDue(lastDay, postedMs, now)) continue;
    try {
      const token = channelToken(channel, key);
      const reading = channel.platform === 'instagram' ? await readers.instagramPost(entry.remoteId, token) : await readers.facebookPost(entry.remoteId, token);
      const caption = (reading.caption ?? before?.caption ?? '').slice(0, CAPTION_KEEP);
      file = recordPost(
        file,
        logKey,
        {
          brand: channel.brand,
          channel: channel.id,
          platform: channel.platform as AnalyticsPlatform,
          permalink: reading.permalink ?? entry.permalink ?? before?.permalink ?? null,
          postedAt: entry.postedAt,
          caption,
          tags: hashtagsOf(reading.caption ?? before?.caption ?? ''),
        },
        today,
        reading.numbers,
        now,
      );
      report.posts += 1;
    } catch (error) {
      report.failures.push({ id: logKey, reason: reasonOf(error) });
    }
  }
  return { file: { ...file, checkedAt: new Date(now).toISOString() }, report };
}
