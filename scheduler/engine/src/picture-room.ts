/** How much room a channel has left this week, read from the paid-call ledger (kept apart from picture-limit.ts so the ledger and the limit do not import each other). */
import { foldLedgerFile } from './paid-ledger.ts';
import { channelPicturesUsed, pictureWeek } from './picture-limit.ts';
import { NETWORKS, type Network } from './networks.ts';

/** How many more pictures a channel may have this week: the limit less what the ledger says was bought (0 when the ledger cannot be read, so nothing is bought blind). */
export function pictureRoomFor(input: { ledgerFile: string; brand: string; network: string; limit: number; now: Date }): number {
  if (!(NETWORKS as readonly string[]).includes(input.network)) return 0;
  try {
    const used = channelPicturesUsed(foldLedgerFile(input.ledgerFile).values(), input.brand, pictureWeek(input.now))[input.network as Network];
    return Math.max(0, input.limit - used);
  } catch {
    return 0;
  }
}
