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

/** The team's own Instagram account, set in the server's settings rather than connected as a channel; its posts are logged under the id "instagram". */
export interface TeamInstagram {
  userId: string;
  /** The account's token, already in the clear (it is read from the environment, not from the channel file). */
  token: string;
  /** Which client a post belongs to, since one account serves several. */
  brandOfPost(postId: string): string | undefined;
  /**
   * The account's own recent posts, matched to the posts we sent by their words. The sender does not write a published team post into the posted log (it
   * only checks the account's recent posts before sending), so the log cannot say where a post went; the account itself can.
   */
  discover(now: number): Promise<Array<{ postId: string; remoteId: string; permalink: string | null; postedAt: string }>>;
}

export const TEAM_INSTAGRAM_ID = 'instagram';

export interface CollectInput {
  file: AnalyticsFile;
  channels: readonly Channel[];
  posted: PostedLog;
  key: Buffer;
  googleApp: GoogleApp | null;
  readers: AnalyticsReaders;
  now: number;
  team?: TeamInstagram | null;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** A log entry that is a real post on the network (not held, repeated or dropped because the account was gone). */
const isSent = (entry: PostedLog[string]): boolean => entry.skipped !== true && entry.duplicateOf === undefined && entry.reason === undefined && entry.remoteId !== '' && !['held', 'duplicate', 'account-disconnected'].includes(entry.remoteId);

/**
 * Nothing is read again sooner than this, so a check run by hand an hour after the last one costs the networks nothing. It is a little under the three hours
 * between the timer's runs, so a run that starts a few seconds late is never mistaken for "too soon" and skipped.
 */
export const MIN_REREAD_MS = 170 * 60_000;

function postIsDue(lastDay: string | undefined, lastReadAt: string | undefined, postedMs: number, now: number): boolean {
  if (lastDay === undefined) return true;
  if (lastReadAt !== undefined && now - Date.parse(lastReadAt) < MIN_REREAD_MS) return false;
  const today = dayOf(now);
  if (now - postedMs <= DAILY_DAYS * DAY_MS) return true;
  return lastDay < today && Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`) >= 7 * DAY_MS;
}

export async function collectAnalytics(input: CollectInput): Promise<{ file: AnalyticsFile; report: CollectReport }> {
  const { channels, key, googleApp, readers, now, team } = input;
  let posted = input.posted;
  const today = dayOf(now);
  const report: CollectReport = { posts: 0, accounts: 0, failures: [] };
  const byId = new Map(channels.map((c) => [c.id, c] as const));
  let file = keepChannels(input.file ?? EMPTY_ANALYTICS, new Set([...byId.keys(), ...(team ? [TEAM_INSTAGRAM_ID] : [])]));
  /** A post of the team's account, treated as a post of an Instagram channel of the client it belongs to. */
  const teamChannel = (postId: string): Channel | undefined => (team ? { id: TEAM_INSTAGRAM_ID, platform: 'instagram', brand: team.brandOfPost(postId) ?? 'default', userId: team.userId, username: 'Instagram', token: '', expiresAt: '', connectedAt: '' } : undefined);
  const tokenOf = (c: Channel): string => (team && c.id === TEAM_INSTAGRAM_ID ? team.token : channelToken(c, key));

  for (const channel of channels) {
    const prior = file.accounts[channel.id];
    if (prior && now - Date.parse(prior.checkedAt) < MIN_REREAD_MS) continue;
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
      // A connection the network withdrew is for the customer to connect again: say so, rather than showing "waiting" for ever.
      if (/connect google again|withdrawn|expired/i.test(reasonOf(error)) && channel.platform === 'google') {
        file = recordAccount(file, channel.id, { brand: channel.brand, channel: channel.id, platform: channel.platform, label: channelLabel(channel), needs: ['reconnect'], checkedAt: new Date(now).toISOString() }, {}, now);
      }
    }
  }

  if (team) {
    try {
      const found = await team.discover(now);
      posted = { ...posted };
      for (const f of found) {
        const logKey = `${f.postId}|${TEAM_INSTAGRAM_ID}`;
        if (posted[logKey] === undefined || !isSent(posted[logKey] as PostedLog[string])) posted[logKey] = { remoteId: f.remoteId, permalink: f.permalink, postedAt: f.postedAt };
      }
    } catch (error) {
      report.failures.push({ id: TEAM_INSTAGRAM_ID, reason: reasonOf(error) });
    }
  }

  if (team) {
    const newest = Object.entries(posted).filter(([k, e]) => k.endsWith(`|${TEAM_INSTAGRAM_ID}`) && isSent(e)).sort(([, a], [, b]) => b.postedAt.localeCompare(a.postedAt))[0];
    const brand = newest ? team.brandOfPost(newest[0].slice(0, newest[0].lastIndexOf('|'))) : undefined;
    const prior = file.accounts[TEAM_INSTAGRAM_ID];
    if (brand && !(prior && now - Date.parse(prior.checkedAt) < MIN_REREAD_MS)) {
      try {
        const reading = await readers.instagramAccount(team.userId, team.token, today);
        file = recordAccount(file, TEAM_INSTAGRAM_ID, { brand, channel: TEAM_INSTAGRAM_ID, platform: 'instagram', label: 'Instagram', ...(reading.audience ? { audience: reading.audience } : prior?.audience ? { audience: prior.audience } : {}), ...(reading.needs.length > 0 ? { needs: reading.needs } : {}), checkedAt: new Date(now).toISOString() }, reading.numbers, now);
        report.accounts += 1;
      } catch (error) {
        report.failures.push({ id: TEAM_INSTAGRAM_ID, reason: reasonOf(error) });
      }
    }
  }

  for (const [logKey, entry] of Object.entries(posted)) {
    const channelId = logKey.slice(logKey.lastIndexOf('|') + 1);
    const postId = logKey.slice(0, logKey.lastIndexOf('|'));
    const channel = byId.get(channelId) ?? (channelId === TEAM_INSTAGRAM_ID ? teamChannel(postId) : undefined);
    if (!channel || (channel.platform !== 'instagram' && channel.platform !== 'facebook') || !isSent(entry)) continue;
    const postedMs = Date.parse(entry.postedAt);
    if (Number.isNaN(postedMs) || now - postedMs > POST_WATCH_DAYS * DAY_MS) continue;
    const before = file.posts[logKey];
    const lastDay = before ? Object.keys(before.series).sort().pop() : undefined;
    if (!postIsDue(lastDay, file.postsRead?.[logKey], postedMs, now)) continue;
    try {
      const token = tokenOf(channel);
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
      file = { ...file, postsRead: { ...(file.postsRead ?? {}), [logKey]: new Date(now).toISOString() } };
      report.posts += 1;
    } catch (error) {
      report.failures.push({ id: logKey, reason: reasonOf(error) });
    }
  }
  return { file: { ...file, checkedAt: new Date(now).toISOString() }, report };
}
