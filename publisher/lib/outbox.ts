/**
 * The events a product is told about, kept so that none is lost: each is written down before anyone tries to deliver it, a failed delivery is retried a
 * few times with growing waits, and the product can ask for everything it has not seen yet (GET /api/v1/events) if it was down or missed one.
 *
 * Pure functions over one JSON document (events.json); the handlers that load and save it are in lib/events.ts.
 */
import type { WebhookEvent } from './webhooks.js';

export interface OutboxEntry {
  /** Counts up for ever; a product that remembers the last one it saw can ask for what came after. */
  seq: number;
  product: string;
  event: WebhookEvent;
  attempts: number;
  /** When the next delivery is tried; null when none is (delivered, given up, or the product has no webhook address and reads the events instead). */
  nextAttemptAt: string | null;
  deliveredAt?: string;
  gaveUpAt?: string;
}

export interface Outbox {
  nextSeq: number;
  entries: OutboxEntry[];
  /** What has already been turned into an event ("job:<id>", "poster:<id>"), so each is announced once. */
  announced: string[];
}

export const EMPTY_OUTBOX: Outbox = { nextSeq: 1, entries: [], announced: [] };

/** The wait after each failed delivery; after the last one the event is given up on (the product can still read it). */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** Events are kept this long, and at most this many. */
export const RETENTION_MS = 14 * 24 * 3_600_000;
const MAX_ENTRIES = 2000;
const MAX_ANNOUNCED = 4000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the stored document; anything that is not the expected shape is an error, never quietly emptied (that would resend or lose events). */
export function parseOutbox(value: unknown): Outbox {
  if (!isObject(value) || typeof value['nextSeq'] !== 'number' || !Array.isArray(value['entries']) || !Array.isArray(value['announced'])) throw new Error('events.json is not a valid event log');
  const entries = value['entries'].map((raw): OutboxEntry => {
    if (!isObject(raw) || typeof raw['seq'] !== 'number' || typeof raw['product'] !== 'string' || !isObject(raw['event']) || typeof raw['attempts'] !== 'number') throw new Error('events.json has a damaged entry');
    const next = raw['nextAttemptAt'];
    return {
      seq: raw['seq'],
      product: raw['product'],
      event: raw['event'] as unknown as WebhookEvent,
      attempts: raw['attempts'],
      nextAttemptAt: typeof next === 'string' ? next : null,
      ...(typeof raw['deliveredAt'] === 'string' ? { deliveredAt: raw['deliveredAt'] } : {}),
      ...(typeof raw['gaveUpAt'] === 'string' ? { gaveUpAt: raw['gaveUpAt'] } : {}),
    };
  });
  return { nextSeq: value['nextSeq'], entries, announced: value['announced'].filter((k): k is string => typeof k === 'string') };
}

/** Writes new events down. `deliverable` says whether a product has a webhook address; one without it only reads its events. */
export function addEntries(outbox: Outbox, items: ReadonlyArray<{ product: string; event: WebhookEvent }>, deliverable: (product: string) => boolean, now: number): { outbox: Outbox; added: OutboxEntry[] } {
  let seq = outbox.nextSeq;
  const added = items.map(({ product, event }): OutboxEntry => ({
    seq: seq++,
    product,
    event: { ...event, seq: seq - 1 },
    attempts: 0,
    nextAttemptAt: deliverable(product) ? new Date(now).toISOString() : null,
  }));
  return { outbox: { ...outbox, nextSeq: seq, entries: [...outbox.entries, ...added] }, added };
}

/** Notes how a delivery went: delivered, or failed (retried later, or given up on after the last try). */
export function recordAttempt(outbox: Outbox, seq: number, ok: boolean, now: number): Outbox {
  return {
    ...outbox,
    entries: outbox.entries.map((e) => {
      if (e.seq !== seq || e.deliveredAt || e.gaveUpAt) return e;
      const attempts = e.attempts + 1;
      const at = new Date(now).toISOString();
      if (ok) return { ...e, attempts, nextAttemptAt: null, deliveredAt: at };
      const delay = RETRY_DELAYS_MS[attempts - 1];
      return delay === undefined ? { ...e, attempts, nextAttemptAt: null, gaveUpAt: at } : { ...e, attempts, nextAttemptAt: new Date(now + delay).toISOString() };
    }),
  };
}

/** The deliveries whose time has come, oldest first. */
export function dueEntries(outbox: Outbox, now: number): OutboxEntry[] {
  return outbox.entries.filter((e) => !e.deliveredAt && !e.gaveUpAt && e.nextAttemptAt !== null && Date.parse(e.nextAttemptAt) <= now).sort((a, b) => a.seq - b.seq);
}

export const isAnnounced = (outbox: Pick<Outbox, 'announced'>, key: string): boolean => outbox.announced.includes(key);
export const withAnnouncedKeys = (outbox: Outbox, keys: readonly string[]): Outbox => ({ ...outbox, announced: [...new Set([...outbox.announced, ...keys])] });

/** Drops what is too old or too many, keeping the newest. */
export function trimmed(outbox: Outbox, now: number): Outbox {
  const fresh = outbox.entries.filter((e) => now - Date.parse(e.event.createdAt) < RETENTION_MS);
  return { ...outbox, entries: fresh.slice(-MAX_ENTRIES), announced: outbox.announced.slice(-MAX_ANNOUNCED) };
}

export interface ReadEvent {
  seq: number;
  id: string;
  type: WebhookEvent['type'];
  createdAt: string;
  data: Record<string, unknown>;
}

/** What one product has not seen yet: its own events after `after`, oldest first, at most `limit`. */
export function eventsAfter(outbox: Outbox, product: string, after: number, limit: number): { events: ReadEvent[]; hasMore: boolean } {
  const mine = outbox.entries.filter((e) => e.product === product && e.seq > after).sort((a, b) => a.seq - b.seq);
  return { events: mine.slice(0, limit).map((e) => ({ seq: e.seq, id: e.event.id, type: e.event.type, createdAt: e.event.createdAt, data: e.event.data })), hasMore: mine.length > limit };
}
