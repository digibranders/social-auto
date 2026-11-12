/** What the analytics check does with the store and the networks, shared by the timer's check and by a person's "refresh now". */
import { collectAnalytics, type AnalyticsReaders, type CollectReport } from './analytics-collect.js';
import { facebookAccount, facebookPost, googleLocation, instagramAccount, instagramPost } from './analytics-fetch.js';
import { parseKey } from './crypto.js';
import { accessTokenFor } from './google.js';
import { loadAnalytics, loadChannels, loadPosted, saveAnalytics } from './store.js';
import { teamInstagram } from './team-instagram.js';

/** On by default; ANALYTICS_ENABLED=false switches the check and the pages off. */
export const analyticsEnabled = (): boolean => process.env['ANALYTICS_ENABLED'] !== 'false';

const realReaders: AnalyticsReaders = {
  instagramPost: (id, token) => instagramPost(id, token),
  instagramAccount: (id, token, today) => instagramAccount(id, token, today),
  facebookPost: (id, token) => facebookPost(id, token),
  facebookAccount: (id, token, today) => facebookAccount(id, token, today),
  googleToken: accessTokenFor,
  googleLocation: (location, token, since, until) => googleLocation(location, token, since, until),
};

export interface CheckOptions {
  /** Only this client. */
  brand?: string;
  /** Read again anything last read longer ago than this. */
  minRereadMs?: number;
  readers?: AnalyticsReaders;
}

/** Reads the numbers and saves them. Returns what was read, never the numbers themselves. */
export async function runAnalyticsCheck(now: number, options: CheckOptions = {}): Promise<CollectReport> {
  const key = parseKey(process.env['CHANNEL_KEY']);
  const clientId = process.env['GOOGLE_CLIENT_ID'];
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET'];
  const [{ file: channels }, { log }, { file, etag }, team] = await Promise.all([loadChannels(), loadPosted(), loadAnalytics(), teamInstagram()]);
  const result = await collectAnalytics({
    file,
    channels: channels.channels,
    posted: log,
    key,
    googleApp: clientId && clientSecret ? { clientId, clientSecret } : null,
    readers: options.readers ?? realReaders,
    now,
    team,
    ...(options.brand !== undefined ? { onlyBrand: options.brand } : {}),
    ...(options.minRereadMs !== undefined ? { minRereadMs: options.minRereadMs } : {}),
  });
  await saveAnalytics(result.file, etag);
  for (const failure of result.report.failures) console.error(`analytics ${failure.id}: ${failure.reason}`);
  return result.report;
}
