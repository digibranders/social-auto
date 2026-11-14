/**
 * A customer disconnecting one of her channels: what it would stop (shown before she confirms) and the best-effort revoke at the network. Nothing here deletes a post: a post aimed at a
 * channel that is gone is held (ACCOUNT_DISCONNECTED) and goes out again if the same account is connected again while its time window is open.
 */
import { postedKey, channelToken, type Channel, type PostedLog } from './channels.js';
import type { JobView } from './engine-client.js';
import { dueWindowFor, type ScheduledPost } from './schedule.js';

const IST_MS = 5.5 * 3_600_000;
const dayOf = (iso: string): string => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);

export interface DisconnectPreview {
  /** Posts still to go out on this channel (not skipped, not sent to it yet, time not past its window). */
  scheduled: number;
  /** The days (YYYY-MM-DD, India time) those posts are for, earliest first. */
  days: string[];
  /** Of the pictures she approved for this platform, how many are for a day not yet over. */
  approved: number;
  /** The kinds of work in progress that touch this channel (a write or a draw), so she can wait for them. */
  running: string[];
  /** True when this is the only channel the workspace has connected. */
  onlyChannel: boolean;
}

/** Whether a post is meant for this account: named by its id, or by its platform (a bare name goes to every connected account of that platform). */
const aimedAt = (post: Pick<ScheduledPost, 'channels'>, channel: Channel): boolean => (post.channels ?? []).some((c) => c === channel.id || c === channel.platform);

/** What disconnecting would stop. `approvedDays` are the planned days of the approved pictures for the platform. */
export function disconnectPreview(input: { channel: Channel; channels: readonly Channel[]; posts: readonly ScheduledPost[]; posted: PostedLog; approvedDays: readonly string[]; jobs: readonly JobView[]; now: number }): DisconnectPreview {
  const { channel, now } = input;
  const going = input.posts.filter((p) => p.skipped !== true && aimedAt(p, channel) && input.posted[postedKey(p.id, channel.id)] === undefined && now <= Date.parse(p.date) + dueWindowFor(p));
  const today = dayOf(new Date(now).toISOString());
  const running = input.jobs.filter((j) => (j.state === 'queued' || j.state === 'running') && (j.networks?.includes(channel.platform) === true || (j.kind === 'draw' && j.networks === undefined))).map((j) => j.kind);
  return {
    scheduled: going.length,
    days: [...new Set(going.map((p) => dayOf(p.date)))].sort(),
    approved: input.approvedDays.filter((d) => d >= today).length,
    running: [...new Set(running)],
    onlyChannel: input.channels.length === 1,
  };
}

/** A sentence for the screen when work for this channel is in progress. */
export const runningSentence = (kinds: readonly string[]): string =>
  `Pictures or posts are being made for this channel (${kinds.join(', ')}). Wait until they are done, then disconnect.`;

export interface RevokeEnv {
  linkedin?: { clientId: string; clientSecret: string; url: string };
  googleUrl: string;
}

/**
 * Asks the network to forget the access we were given, best effort: it never throws and never blocks the disconnect. What is possible: Google (a token revoke needs only the token) and LinkedIn
 * (needs our app's id and secret, which the publisher only has when they are set in its environment). Instagram and Facebook: we hold a Page or account token, and Meta removes an app's permission
 * only through the person's own token, so the person removes the app in her own Facebook settings; nothing is called.
 */
export async function revokeAtNetwork(channel: Channel, key: Buffer, env: RevokeEnv, send: typeof fetch = fetch): Promise<boolean> {
  try {
    if (channel.platform === 'google') {
      const answer = await send(env.googleUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: channelToken(channel, key) }), signal: AbortSignal.timeout(8_000) });
      return answer.ok;
    }
    if (channel.platform === 'linkedin' && env.linkedin) {
      const answer = await send(env.linkedin.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.linkedin.clientId, client_secret: env.linkedin.clientSecret, token: channelToken(channel, key) }), signal: AbortSignal.timeout(8_000) });
      return answer.ok;
    }
  } catch (error) {
    console.error(`could not revoke ${channel.platform} access: ${error instanceof Error ? error.message : String(error)}`);
  }
  return false;
}

export function revokeEnvFromProcess(env: Record<string, string | undefined> = process.env): RevokeEnv {
  const id = env['LINKEDIN_CLIENT_ID'];
  const secret = env['LINKEDIN_CLIENT_SECRET'];
  return {
    googleUrl: env['GOOGLE_REVOKE_URL'] ?? 'https://oauth2.googleapis.com/revoke',
    ...(id && secret ? { linkedin: { clientId: id, clientSecret: secret, url: env['LINKEDIN_REVOKE_URL'] ?? 'https://www.linkedin.com/oauth/v2/revoke' } } : {}),
  };
}

