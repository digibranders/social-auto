/** Things the customer should know about their own workspace, in plain words, for the product to show. Read only: nothing here can be changed through the API. */
import { channelLabel, type Channel } from './channels.js';
import { goneAims } from './post-view.js';
import type { ScheduledPost } from './schedule.js';

export interface Notice {
  code: 'CONNECTION_EXPIRED' | 'CONNECTION_EXPIRING' | 'PAUSED' | 'ACCOUNT_DISCONNECTED';
  /** The account it is about; absent for a notice about the whole workspace. */
  channelId?: string;
  platform?: string;
  message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_DAYS = 7;
const NAMES: Record<string, string> = { linkedin: 'LinkedIn', instagram: 'Instagram', facebook: 'Facebook', google: 'Google Business' };
const nameOf = (platform: string): string => NAMES[platform] ?? platform;

/**
 * The scheduled posts still ahead that are aimed at an account or platform that is not connected, said once per platform in plain words: they wait, and go out
 * once it is connected again (if their time has not passed by then).
 */
export function disconnectedNotices(posts: readonly Pick<ScheduledPost, 'date' | 'channels' | 'fromPlan' | 'skipped'>[], channels: readonly Channel[], now: number): Notice[] {
  const ids = new Set(channels.map((c) => c.id));
  const platforms = new Set<string>(channels.map((c) => c.platform));
  const counts = new Map<string, number>();
  for (const post of posts) {
    if (post.skipped === true || Date.parse(post.date) <= now) continue;
    for (const platform of new Set(goneAims(post, ids, platforms).map((a) => (a.includes(':') ? a.slice(0, a.indexOf(':')) : a)))) counts.set(platform, (counts.get(platform) ?? 0) + 1);
  }
  return [...counts].map(([platform, n]): Notice => ({
    code: 'ACCOUNT_DISCONNECTED',
    platform,
    message: `Your ${nameOf(platform)} account is not connected, so ${n} scheduled post${n === 1 ? ' is' : 's are'} for it on hold. Connect it again and ${n === 1 ? 'it' : 'they'} will go out if the time has not passed.`,
  }));
}

export function noticesFor(channels: readonly Channel[], workspacePaused: boolean, now: number): Notice[] {
  const notices: Notice[] = [];
  if (workspacePaused) notices.push({ code: 'PAUSED', message: 'Posting is paused for now, so nothing will be sent until it is resumed.' });
  for (const channel of channels) {
    if (channel.platform !== 'linkedin' && channel.platform !== 'instagram') continue;
    const left = Date.parse(channel.expiresAt) - now;
    const who = `${nameOf(channel.platform)} (${channelLabel(channel)})`;
    if (Number.isNaN(left)) continue;
    if (left <= 0) notices.push({ code: 'CONNECTION_EXPIRED', channelId: channel.id, platform: channel.platform, message: `${who} needs to be connected again. Posts to it are on hold until then.` });
    else if (left <= WARN_DAYS * DAY_MS) notices.push({ code: 'CONNECTION_EXPIRING', channelId: channel.id, platform: channel.platform, message: `${who} needs to be connected again within ${Math.max(1, Math.ceil(left / DAY_MS))} day${Math.ceil(left / DAY_MS) === 1 ? '' : 's'}, or posts to it will stop.` });
  }
  return notices;
}
