import type { ConnectedChannel } from './analytics.js';
import { channelLabel } from './channels.js';
import { loadAnalytics, loadChannels } from './store.js';

/** The channels connected for a brand (every network, including those that give no numbers), without anything secret. */
export async function connectedFor(brand: string): Promise<ConnectedChannel[]> {
  const { file } = await loadChannels();
  const own = file.channels.filter((c) => c.brand === brand).map((c) => ({ id: c.id, platform: c.platform, label: channelLabel(c) }));
  // The team's own Instagram account is not a connected channel, but it posts for the client when the client has none of its own.
  const { file: numbers } = await loadAnalytics();
  const team = numbers.accounts['instagram'];
  return team && team.brand === brand && !own.some((c) => c.platform === 'instagram') ? [...own, { id: 'instagram', platform: 'instagram', label: team.label }] : own;
}
