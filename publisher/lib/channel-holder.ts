import type { ChannelFile } from './channels.js';
import { groupOf, type ClientsFile } from './clients.js';
import { json } from './http.js';

/** What a customer's own connect link asked for. Staff and team invite links send no options and keep the old behaviour. */
export interface HolderOptions {
  /** True when the person came through a product's connect link (the customer connecting their own account). */
  guard: boolean;
  /** The externalId of another brand of the same customer that the customer agreed to take this account away from. */
  moveFrom?: string | undefined;
}

export type HolderVerdict = { ok: true } | { ok: false; heldBy?: string };

/**
 * Decides whether `brand` may take the channels `ids`. A channel id is held by one workspace at a time, so saving it
 * for a second workspace silently moves it. For a customer's own link that never happens by surprise:
 * - held by another customer or product: refused, and we never say whose;
 * - held by another brand of the same customer: refused with that brand's id, unless the link carried the
 *   customer's explicit "move it from <that brand>";
 * - held by this workspace, or by nobody: fine.
 */
export function checkHolders(channels: ChannelFile, clients: ClientsFile, brand: string, ids: readonly string[], options: HolderOptions): HolderVerdict {
  if (!options.guard) return { ok: true };
  const me = clients.clients.find((c) => c.brand === brand);
  const wanted = new Set(ids);
  let heldBy: string | undefined;
  for (const channel of channels.channels) {
    if (!wanted.has(channel.id) || channel.brand === brand) continue;
    const holder = clients.clients.find((c) => c.brand === channel.brand);
    const sameCustomer = me !== undefined && holder !== undefined && me.product !== undefined && holder.product === me.product && groupOf(holder) === groupOf(me);
    if (!sameCustomer || holder === undefined || holder.externalId === undefined) return { ok: false };
    if (options.moveFrom !== holder.externalId) heldBy = holder.externalId;
  }
  return heldBy === undefined ? { ok: true } : { ok: false, heldBy };
}

/** The coded answer the dashboard turns into `?social=failed&reason=ACCOUNT_IN_USE` for the product. */
export const accountInUse = (verdict: { heldBy?: string }): Response =>
  json(409, { code: 'ACCOUNT_IN_USE', error: 'This account is already connected to another workspace.', ...(verdict.heldBy ? { heldBy: verdict.heldBy } : {}) });

/** Reads the guard and move option from a connect call's body. */
export function holderOptions(body: Record<string, unknown> | null): HolderOptions {
  const moveFrom = body?.['moveFrom'];
  return { guard: body?.['guard'] === true, ...(typeof moveFrom === 'string' && moveFrom ? { moveFrom } : {}) };
}
