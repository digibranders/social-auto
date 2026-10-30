import { decrypt, encrypt } from './crypto.js';
import type { FacebookPage } from './facebook.js';

/** A connected place to post, belonging to one client (brand). Tokens are stored encrypted. */
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

export type Channel = FacebookChannel;

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

export function parseChannels(raw: unknown): ChannelFile {
  const list = (raw as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(list)) throw new Error('channels file must contain a "channels" array');
  const channels = list.map((c: Record<string, unknown>, i): Channel => {
    for (const key of ['id', 'brand', 'pageId', 'pageName', 'token', 'connectedAt'] as const) {
      if (typeof c[key] !== 'string' || !c[key]) throw new Error(`channels[${i}].${key} must be a non-empty string`);
    }
    if (c['platform'] !== 'facebook') throw new Error(`channels[${i}].platform is not supported`);
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

export function removeChannel(file: ChannelFile, id: string): ChannelFile {
  return { channels: file.channels.filter((c) => c.id !== id) };
}

export function channelToken(channel: Channel, key: Buffer): string {
  return decrypt(channel.token, key);
}

/** The channels of one client. */
export function channelsFor(file: ChannelFile, brand: string): Channel[] {
  return file.channels.filter((c) => c.brand === brand);
}
