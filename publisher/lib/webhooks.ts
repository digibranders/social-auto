import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ClientsFile } from './clients.js';
import type { CrosspostResult } from './crosspost.js';
import { channelLabel, type ExpiringChannel } from './channels.js';
import type { Product } from './products.js';

/** A message to a product about something that happened to one of its customers. */
export interface WebhookEvent {
  id: string;
  type: 'post.published' | 'post.failed' | 'connection.expiring' | 'job.finished' | 'poster.ready' | 'poster.expiring' | 'poster.expired' | 'week.drawing' | 'week.drawn' | 'week.lapsed' | 'post.held' | 'post.missed';
  /** The place of the event in the product's log (see lib/outbox.ts); present once it was written down. */
  seq?: number;
  createdAt: string;
  data: Record<string, unknown>;
}

const TOLERANCE_SECONDS = 5 * 60;

/** `t=<unix seconds>,v1=<hex>`: an HMAC-SHA256 over "<t>.<body>" with the product's webhook secret. */
export function signBody(secret: string, body: string, nowSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${nowSeconds}.${body}`).digest('hex');
  return `t=${nowSeconds},v1=${v1}`;
}

/** For the receiving side (and our tests): true only for our signature, made recently, over exactly this body. */
export function verifySignature(secret: string, body: string, header: string | null, nowSeconds: number): boolean {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return false;
  const sentAt = Number(match[1]);
  if (Math.abs(nowSeconds - sentAt) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signBody(secret, body, sentAt));
  const actual = Buffer.from(header as string);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const newEvent = (type: WebhookEvent['type'], data: Record<string, unknown>, now: number): WebhookEvent => ({
  id: randomUUID(),
  type,
  createdAt: new Date(now).toISOString(),
  data,
});

/** The customer a workspace id belongs to, if a product created it: which product and its own id for them. */
export function ownerOf(clients: ClientsFile, brand: string): { product: string; externalId: string } | null {
  const client = clients.clients.find((c) => c.brand === brand);
  return client?.product && client.externalId ? { product: client.product, externalId: client.externalId } : null;
}

export interface Addressed {
  product: string;
  event: WebhookEvent;
}

/** What to tell products after the daily run sent a post: one event per channel that published or failed. */
export function eventsForResults(brand: string, postId: string, results: readonly CrosspostResult[], clients: ClientsFile, now: number): Addressed[] {
  const owner = ownerOf(clients, brand);
  if (!owner) return [];
  return results.flatMap((r): Addressed[] => {
    if (r.status !== 'posted' && r.status !== 'failed') return [];
    const base = { externalId: owner.externalId, postId, channel: r.channel, account: r.account };
    return [{
      product: owner.product,
      event: r.status === 'posted' ? newEvent('post.published', { ...base, permalink: r.permalink ?? null }, now) : newEvent('post.failed', { ...base, error: r.error ?? 'unknown error' }, now),
    }];
  });
}

/** What to tell a product when one of its customers' connections (LinkedIn or Instagram) is about to end. */
export function eventForExpiry(channel: ExpiringChannel, days: number, clients: ClientsFile, now: number): Addressed | null {
  const owner = ownerOf(clients, channel.brand);
  if (!owner) return null;
  return {
    product: owner.product,
    event: newEvent('connection.expiring', { externalId: owner.externalId, platform: channel.platform, account: channelLabel(channel), daysLeft: days, expiresAt: channel.expiresAt }, now),
  };
}

/** Sends one event. Never throws: a product that is down must not stop posting. Answers whether it was accepted. */
export async function deliver(product: Product, event: WebhookEvent, send: typeof fetch = fetch): Promise<boolean> {
  if (!product.webhookUrl || !product.webhookSecret) return false;
  const body = JSON.stringify(event);
  try {
    const response = await send(product.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Social-Signature': signBody(product.webhookSecret, body, Math.floor(Date.now() / 1000)), 'X-Social-Event': event.type },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!response.ok) console.error(`webhook to ${product.id} answered ${response.status}`);
    return response.ok;
  } catch (error) {
    console.error(`webhook to ${product.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Sends each event to its product, one after another. Products without a webhook address are skipped. */
export async function dispatch(items: readonly Addressed[], products: readonly Product[], send: typeof fetch = fetch): Promise<void> {
  for (const { product, event } of items) {
    const target = products.find((p) => p.id === product);
    if (target) await deliver(target, event, send);
  }
}

/** What to tell a product when a post of one of its customers missed its window on an account (once per post and account). */
export function eventsForMissed(missed: ReadonlyArray<{ brand: string; postId: string; channelId: string; account: string; date: string }>, clients: ClientsFile, now: number): Addressed[] {
  return missed.flatMap((m): Addressed[] => {
    const owner = ownerOf(clients, m.brand);
    return owner ? [{ product: owner.product, event: newEvent('post.missed', { externalId: owner.externalId, postId: m.postId, channel: m.channelId, account: m.account, date: m.date }, now) }] : [];
  });
}

/** What to tell a product when a post of one of its customers is due but an account it was aimed at is no longer connected: the post waits for the account. */
export function eventsForHeld(held: ReadonlyArray<{ brand: string; postId: string; channelId: string; platform: string; date: string }>, clients: ClientsFile, now: number): Addressed[] {
  return held.flatMap((h): Addressed[] => {
    const owner = ownerOf(clients, h.brand);
    return owner ? [{ product: owner.product, event: newEvent('post.held', { externalId: owner.externalId, postId: h.postId, channel: h.channelId, platform: h.platform, date: h.date, code: 'ACCOUNT_DISCONNECTED' }, now) }] : [];
  });
}
