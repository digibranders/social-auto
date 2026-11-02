import { decrypt, encrypt } from './crypto.js';
import type { FacebookPage } from './facebook.js';

/** A Facebook Page connected for a client (brand). Tokens are stored encrypted. */
export interface FacebookChannel {
  /** "facebook:<page id>" */
  id: string;
  platform: 'facebook';
  brand: string;
  pageId: string;
  pageName: string;
  /** Encrypted Page token (see crypto.ts). Never sent to a browser. */
  token: string;
  connectedAt: string;
}

/** A person's LinkedIn profile connected for a client. The client approved the app themselves. */
export interface LinkedInChannel {
  /** "linkedin:<member id>" */
  id: string;
  platform: 'linkedin';
  brand: string;
  /** "urn:li:person:<id>": the author of every post. */
  memberUrn: string;
  memberName: string;
  /** Encrypted access token. LinkedIn gives self-serve apps no refresh token, so it ends at expiresAt. */
  token: string;
  expiresAt: string;
  connectedAt: string;
}

/** One business location on Google, posted to as updates. The saved token is Google's refresh token, which does not expire by itself. */
export interface GoogleChannel {
  /** "google:<location id>" */
  id: string;
  platform: 'google';
  brand: string;
  /** "accounts/<id>" */
  account: string;
  /** "locations/<id>" */
  location: string;
  locationTitle: string;
  /** Encrypted refresh token. */
  token: string;
  connectedAt: string;
}

/** A customer's own Instagram account connected for a client (the team's own account is set in the environment, not here). */
export interface InstagramChannel {
  /** "instagram:<account id>" */
  id: string;
  platform: 'instagram';
  brand: string;
  /** The account's id, used in every posting call. */
  userId: string;
  username: string;
  /** Encrypted token. It lasts about 60 days and is renewed weekly (api/refresh.ts); it ends at expiresAt if renewal stops. */
  token: string;
  expiresAt: string;
  connectedAt: string;
}

export type Channel = FacebookChannel | LinkedInChannel | GoogleChannel | InstagramChannel;

/** A connection with an end date: the person must connect again (or the weekly renewal must work) before it. */
export type ExpiringChannel = LinkedInChannel | InstagramChannel;

export interface ChannelFile {
  channels: Channel[];
}

/** What was already sent to a channel, so a retry never posts twice. Keyed "<post id>|<channel id>". */
export interface PostedEntry {
  remoteId: string;
  permalink: string | null;
  postedAt: string;
}
export type PostedLog = Record<string, PostedEntry>;

export const postedKey = (postId: string, channelId: string): string => `${postId}|${channelId}`;

/** The name people see for a channel: the Page, the member, the Google location or the Instagram username. */
export const channelLabel = (channel: Channel): string => {
  switch (channel.platform) {
    case 'facebook':
      return channel.pageName;
    case 'linkedin':
      return channel.memberName;
    case 'google':
      return channel.locationTitle;
    case 'instagram':
      return channel.username;
  }
};

function requireText(c: Record<string, unknown>, keys: readonly string[], i: number): void {
  for (const key of keys) {
    if (typeof c[key] !== 'string' || !c[key]) throw new Error(`channels[${i}].${key} must be a non-empty string`);
  }
}

export function parseChannels(raw: unknown): ChannelFile {
  const list = (raw as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(list)) throw new Error('channels file must contain a "channels" array');
  const channels = list.map((c: Record<string, unknown>, i): Channel => {
    if (c['platform'] === 'facebook') {
      requireText(c, ['id', 'brand', 'pageId', 'pageName', 'token', 'connectedAt'], i);
    } else if (c['platform'] === 'linkedin') {
      requireText(c, ['id', 'brand', 'memberUrn', 'memberName', 'token', 'expiresAt', 'connectedAt'], i);
      if (Number.isNaN(Date.parse(c['expiresAt'] as string))) throw new Error(`channels[${i}].expiresAt is not a date`);
    } else if (c['platform'] === 'instagram') {
      requireText(c, ['id', 'brand', 'userId', 'username', 'token', 'expiresAt', 'connectedAt'], i);
      if (Number.isNaN(Date.parse(c['expiresAt'] as string))) throw new Error(`channels[${i}].expiresAt is not a date`);
    } else if (c['platform'] === 'google') {
      requireText(c, ['id', 'brand', 'account', 'location', 'locationTitle', 'token', 'connectedAt'], i);
    } else {
      throw new Error(`channels[${i}].platform is not supported`);
    }
    return c as unknown as Channel;
  });
  return { channels };
}

export function parsePostedLog(raw: unknown): PostedLog {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('posted log must be an object');
  for (const [key, value] of Object.entries(raw)) {
    const entry = value as Record<string, unknown>;
    if (typeof entry?.['remoteId'] !== 'string' || typeof entry['postedAt'] !== 'string') {
      throw new Error(`posted log entry "${key}" is malformed`);
    }
  }
  return raw as PostedLog;
}

/** Saves the Pages a person approved for a client. Reconnecting a Page replaces its token, keeping one entry. */
export function addFacebookPages(file: ChannelFile, brand: string, pages: FacebookPage[], key: Buffer, now: number): ChannelFile {
  const incoming = pages.map((page): FacebookChannel => ({
    id: `facebook:${page.id}`,
    platform: 'facebook',
    brand,
    pageId: page.id,
    pageName: page.name,
    token: encrypt(page.accessToken, key),
    connectedAt: new Date(now).toISOString(),
  }));
  const ids = new Set(incoming.map((c) => c.id));
  return { channels: [...file.channels.filter((c) => !ids.has(c.id)), ...incoming] };
}

/** Saves a member's LinkedIn connection for a client. Connecting again replaces the old token. */
export function addLinkedInMember(
  file: ChannelFile,
  brand: string,
  member: { urn: string; name: string },
  accessToken: string,
  expiresInSeconds: number,
  key: Buffer,
  now: number,
): ChannelFile {
  const channel: LinkedInChannel = {
    id: `linkedin:${member.urn.split(':').pop()}`,
    platform: 'linkedin',
    brand,
    memberUrn: member.urn,
    memberName: member.name,
    token: encrypt(accessToken, key),
    expiresAt: new Date(now + expiresInSeconds * 1000).toISOString(),
    connectedAt: new Date(now).toISOString(),
  };
  return { channels: [...file.channels.filter((c) => c.id !== channel.id), channel] };
}

/** Saves a business location for a client. Connecting it again replaces the old token. */
export function addGoogleLocation(
  file: ChannelFile,
  brand: string,
  place: { account: string; location: string; title: string },
  refreshToken: string,
  key: Buffer,
  now: number,
): ChannelFile {
  const channel: GoogleChannel = {
    id: `google:${place.location.split('/').pop()}`,
    platform: 'google',
    brand,
    account: place.account,
    location: place.location,
    locationTitle: place.title,
    token: encrypt(refreshToken, key),
    connectedAt: new Date(now).toISOString(),
  };
  return { channels: [...file.channels.filter((c) => c.id !== channel.id), channel] };
}

/** Saves a customer's Instagram account for a client. Connecting again replaces the old token. */
export function addInstagramAccount(
  file: ChannelFile,
  brand: string,
  account: { userId: string; username: string },
  accessToken: string,
  expiresInSeconds: number,
  key: Buffer,
  now: number,
): ChannelFile {
  const channel: InstagramChannel = {
    id: `instagram:${account.userId}`,
    platform: 'instagram',
    brand,
    userId: account.userId,
    username: account.username,
    token: encrypt(accessToken, key),
    expiresAt: new Date(now + expiresInSeconds * 1000).toISOString(),
    connectedAt: new Date(now).toISOString(),
  };
  return { channels: [...file.channels.filter((c) => c.id !== channel.id), channel] };
}

/** Stores a renewed token and its new end date for one connected Instagram account. */
export function renewInstagramToken(file: ChannelFile, id: string, accessToken: string, expiresInSeconds: number, key: Buffer, now: number): ChannelFile {
  return {
    channels: file.channels.map((c) =>
      c.platform === 'instagram' && c.id === id ? { ...c, token: encrypt(accessToken, key), expiresAt: new Date(now + expiresInSeconds * 1000).toISOString() } : c,
    ),
  };
}

export function removeChannel(file: ChannelFile, id: string): ChannelFile {
  return { channels: file.channels.filter((c) => c.id !== id) };
}

export function channelToken(channel: Channel, key: Buffer): string {
  return decrypt(channel.token, key);
}

/** The channels of one client, optionally of one kind. */
export function channelsFor<P extends Channel['platform']>(
  file: ChannelFile,
  brand: string,
  platform?: P,
): Array<Extract<Channel, { platform: P }>> {
  return file.channels.filter((c) => c.brand === brand && (!platform || c.platform === platform)) as Array<Extract<Channel, { platform: P }>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until a connection ends (negative once it has). */
export const daysLeft = (channel: ExpiringChannel, now: number): number => Math.floor((Date.parse(channel.expiresAt) - now) / DAY_MS);

/** Warn when this many whole days are left. The daily job runs once a day, so each value fires once. */
export const EXPIRY_WARN_AT: readonly number[] = [7, 3, 1, 0];

export function expiringSoon(file: ChannelFile, now: number): Array<{ channel: ExpiringChannel; days: number }> {
  return file.channels
    .filter((c): c is ExpiringChannel => c.platform === 'linkedin' || c.platform === 'instagram')
    .map((channel) => ({ channel, days: daysLeft(channel, now) }))
    .filter(({ days }) => EXPIRY_WARN_AT.includes(days));
}
