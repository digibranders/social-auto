/**
 * Telling products what happened, without losing anything: an event is written to the log first (lib/outbox.ts), then delivered; a delivery that fails is
 * tried again by the next runs of the cron, and the product can read the log (GET /api/v1/events) to catch up.
 */
import { describeError } from './http.js';
import { EditError } from './overrides.js';
import { addEntries, dueEntries, recordAttempt, trimmed, withAnnouncedKeys, type Outbox, type OutboxEntry } from './outbox.js';
import type { Product } from './products.js';
import { loadOutbox, saveOutbox, storeConfigured } from './store.js';
import { deliver, dispatch, type Addressed } from './webhooks.js';

const SAVE_TRIES = 4;

/** Loads the log, changes it and saves it, trying again when another run saved in between. */
async function change(update: (outbox: Outbox) => Outbox): Promise<Outbox> {
  for (let attempt = 1; ; attempt += 1) {
    const { outbox, etag } = await loadOutbox();
    const next = update(outbox);
    try {
      await saveOutbox(next, etag);
      return next;
    } catch (error) {
      if (!(error instanceof EditError && error.status === 409) || attempt >= SAVE_TRIES) throw error;
    }
  }
}

const hasWebhook = (products: readonly Product[]) => (id: string): boolean => {
  const product = products.find((p) => p.id === id);
  return product?.webhookUrl !== undefined && product.webhookSecret !== undefined;
};

/** Tries each delivery once and writes down how it went. Never throws: a product that is down must not stop anything else. */
async function attemptAll(entries: readonly OutboxEntry[], products: readonly Product[], now: number, send: typeof fetch): Promise<void> {
  const results: Array<{ seq: number; ok: boolean }> = [];
  for (const entry of entries) {
    const target = products.find((p) => p.id === entry.product);
    results.push({ seq: entry.seq, ok: target ? await deliver(target, entry.event, send) : false });
  }
  if (results.length === 0) return;
  try {
    await change((outbox) => trimmed(results.reduce((o, r) => recordAttempt(o, r.seq, r.ok, now), outbox), now));
  } catch (error) {
    console.error(describeError(error));
  }
}

/**
 * Writes the events down and delivers them. `announced` marks what they were made from, in the same save, so a source is never announced twice and
 * never lost between being noticed and being written down. Without storage there is no log: they are just sent, once.
 */
export async function publishEvents(items: readonly Addressed[], products: readonly Product[], options: { now?: number; send?: typeof fetch; announced?: readonly string[] } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  const send = options.send ?? fetch;
  if (items.length === 0 && (options.announced?.length ?? 0) === 0) return;
  if (!storeConfigured()) {
    await dispatch(items, products, send);
    return;
  }
  try {
    let added: OutboxEntry[] = [];
    await change((outbox) => {
      const made = addEntries(outbox, items, hasWebhook(products), now);
      added = made.added;
      return trimmed(withAnnouncedKeys(made.outbox, options.announced ?? []), now);
    });
    await attemptAll(added.filter((e) => e.nextAttemptAt !== null), products, now, send);
  } catch (error) {
    console.error(describeError(error));
  }
}

/** Tries again the deliveries that failed and whose wait is over. */
export async function retryDueEvents(products: readonly Product[], now: number = Date.now(), send: typeof fetch = fetch): Promise<void> {
  if (!storeConfigured() || products.length === 0) return;
  try {
    const { outbox } = await loadOutbox();
    await attemptAll(dueEntries(outbox, now), products, now, send);
  } catch (error) {
    console.error(describeError(error));
  }
}
