import type { ConnectedChannel } from './analytics.js';
import { channelLabel } from './channels.js';
import { loadChannels } from './store.js';

/** The channels connected for a brand (every network, including those that give no numbers), without anything secret. */
export async function connectedFor(brand: string): Promise<ConnectedChannel[]> {
  const { file } = await loadChannels();
  return file.channels.filter((c) => c.brand === brand).map((c) => ({ id: c.id, platform: c.platform, label: channelLabel(c) }));
}
