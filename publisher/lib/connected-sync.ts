/**
 * Tells the poster service which networks a customer has connected accounts for. It is told when the customer looks at her written posts or asks for pictures,
 * and only when the list changed since this process last told it, so a busy screen does not make a call each time.
 */
import { channelsFor } from './channels.js';
import type { WorkspaceEngine } from './engine-client.js';
import { loadChannels } from './store.js';

const last = new Map<string, string>();

export async function syncConnected(engine: WorkspaceEngine, brand: string, actor: string): Promise<void> {
  try {
    const { file } = await loadChannels();
    const networks = [...new Set(channelsFor(file, brand).map((c) => c.platform))].sort();
    const key = networks.join(',');
    if (last.get(brand) === key) return;
    await engine.setConnected(networks, actor);
    last.set(brand, key);
  } catch {
    // Never in the way of the call that triggered it.
  }
}

/** For tests: forget what was told. */
export const forgetConnected = (): void => last.clear();
