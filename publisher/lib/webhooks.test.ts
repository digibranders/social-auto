import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinkedInChannel } from './channels.ts';
import type { ClientsFile } from './clients.ts';
import type { Product } from './products.ts';
import { deliver, dispatch, eventForExpiry, eventsForResults, signBody, verifySignature } from './webhooks.ts';

const SECRET = 'whsec_' + 'x'.repeat(20);
const NOW = Date.parse('2026-11-20T05:00:00Z');
const clients: ClientsFile = { clients: [{ brand: 'brandbasket-biz-1-abc123', createdAt: 'x', product: 'brandbasket', externalId: 'biz_1' }, { brand: 'mine', createdAt: 'x' }] };
const product: Product = { id: 'brandbasket', keyHash: 'h'.repeat(64), returnUrls: [], webhookUrl: 'https://app.brandbasket.in/api/webhooks/social', webhookSecret: SECRET };

test('a signature is accepted only for the exact body, the right secret and a recent time', () => {
  const body = '{"a":1}';
  const header = signBody(SECRET, body, 1_000);
  assert.equal(verifySignature(SECRET, body, header, 1_100), true);
  assert.equal(verifySignature(SECRET, '{"a":2}', header, 1_100), false);
  assert.equal(verifySignature('other-secret-other-secret', body, header, 1_100), false);
  assert.equal(verifySignature(SECRET, body, header, 1_000 + 301), false);
  assert.equal(verifySignature(SECRET, body, null, 1_000), false);
  assert.equal(verifySignature(SECRET, body, 't=1000,v1=zz', 1_000), false);
});

test('a product hears only about its own customers, once per channel that published or failed', () => {
  const results = [
    { channel: 'linkedin:abc', account: 'Asha', status: 'posted' as const, permalink: 'https://l/1' },
    { channel: 'facebook:77', account: 'Page', status: 'failed' as const, error: 'token dead' },
    { channel: 'linkedin:zzz', account: 'Old', status: 'already-posted' as const },
    { channel: 'linkedin:yyy', account: 'Early', status: 'skipped-before-connection' as const },
  ];
  const events = eventsForResults('brandbasket-biz-1-abc123', 'manual-0123456789ab', results, clients, NOW);
  assert.deepEqual(events.map((e) => [e.product, e.event.type]), [['brandbasket', 'post.published'], ['brandbasket', 'post.failed']]);
  assert.deepEqual(events[0]?.event.data, { externalId: 'biz_1', postId: 'manual-0123456789ab', channel: 'linkedin:abc', account: 'Asha', permalink: 'https://l/1' });
  assert.equal(events[1]?.event.data['error'], 'token dead');
  assert.deepEqual(eventsForResults('mine', 'p', results, clients, NOW), []);
  assert.notEqual(events[0]?.event.id, events[1]?.event.id);
});

test('a connection about to end is reported to the product that owns the customer', () => {
  const channel = { id: 'linkedin:abc', platform: 'linkedin', brand: 'brandbasket-biz-1-abc123', memberUrn: 'u', memberName: 'Asha', token: 't', expiresAt: '2026-11-27T00:00:00Z', connectedAt: 'c' } as LinkedInChannel;
  const item = eventForExpiry(channel, 7, clients, NOW);
  assert.equal(item?.product, 'brandbasket');
  assert.deepEqual(item?.event.data, { externalId: 'biz_1', platform: 'linkedin', account: 'Asha', daysLeft: 7, expiresAt: '2026-11-27T00:00:00Z' });
  assert.equal(eventForExpiry({ ...channel, brand: 'mine' }, 7, clients, NOW), null);
});

test('delivery signs the exact body it sends, and a down or refusing product never throws', async () => {
  const [item] = eventsForResults('brandbasket-biz-1-abc123', 'p', [{ channel: 'c', account: 'a', status: 'posted' }], clients, NOW);
  const seen: Array<{ url: string; body: string; signature: string; event: string }> = [];
  const ok = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    seen.push({ url, body: init.body as string, signature: headers['X-Social-Signature'] as string, event: headers['X-Social-Event'] as string });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  assert.equal(await deliver(product, item!.event, ok), true);
  assert.equal(seen[0]?.url, product.webhookUrl);
  assert.equal(seen[0]?.event, 'post.published');
  assert.equal(verifySignature(SECRET, seen[0]!.body, seen[0]!.signature, Math.floor(Date.now() / 1000)), true);
  assert.equal(await deliver(product, item!.event, (async () => new Response('no', { status: 500 })) as unknown as typeof fetch), false);
  assert.equal(await deliver(product, item!.event, (async () => { throw new Error('connection refused'); }) as unknown as typeof fetch), false);
  assert.equal(await deliver({ ...product, webhookUrl: undefined }, item!.event, ok), false);
  await dispatch([{ product: 'nobody', event: item!.event }], [product], ok);
  assert.equal(seen.length, 1);
});
