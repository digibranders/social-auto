import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHolders } from './channel-holder.js';
import type { ChannelFile } from './channels.js';
import type { ClientsFile } from './clients.js';

const at = '2026-11-14T00:00:00.000Z';
const client = (brand: string, externalId: string, product: string, group?: string) => ({ brand, createdAt: at, product, externalId, ...(group ? { group } : {}) });
const clients = {
  clients: [client('bb-1', 'c1', 'bb'), client('bb-2', 'c1:b2', 'bb', 'c1'), client('bb-3', 'c3', 'bb'), client('other-1', 'c1', 'other'), { brand: 'staffbrand', createdAt: at }],
} as unknown as ClientsFile;
const held = (brand: string): ChannelFile => ({ channels: [{ id: 'instagram:42', platform: 'instagram', brand }] }) as unknown as ChannelFile;
const own = { guard: true };

test('a staff link (no guard) keeps the old behaviour and moves silently', () => {
  assert.deepEqual(checkHolders(held('bb-1'), clients, 'bb-2', ['instagram:42'], { guard: false }), { ok: true });
});

test('nobody holds it, or the same workspace reconnects it: fine', () => {
  assert.deepEqual(checkHolders({ channels: [] }, clients, 'bb-2', ['instagram:42'], own), { ok: true });
  assert.deepEqual(checkHolders(held('bb-2'), clients, 'bb-2', ['instagram:42'], own), { ok: true });
});

test('another brand of the same customer: refused, naming that brand', () => {
  assert.deepEqual(checkHolders(held('bb-1'), clients, 'bb-2', ['instagram:42'], own), { ok: false, heldBy: 'c1' });
});

test('the same customer may move it only from the brand she named', () => {
  assert.deepEqual(checkHolders(held('bb-1'), clients, 'bb-2', ['instagram:42'], { guard: true, moveFrom: 'c1' }), { ok: true });
  assert.deepEqual(checkHolders(held('bb-1'), clients, 'bb-2', ['instagram:42'], { guard: true, moveFrom: 'c3' }), { ok: false, heldBy: 'c1' });
});

test('another customer, another product or a staff brand: always refused, whose is never said, even with moveFrom', () => {
  for (const holder of ['bb-3', 'other-1', 'staffbrand']) {
    assert.deepEqual(checkHolders(held(holder), clients, 'bb-2', ['instagram:42'], own), { ok: false });
    assert.deepEqual(checkHolders(held(holder), clients, 'bb-2', ['instagram:42'], { guard: true, moveFrom: 'c3' }), { ok: false });
  }
});

test('several pages: one that is held by someone else refuses the whole set', () => {
  const file = { channels: [{ id: 'facebook:1', platform: 'facebook', brand: 'bb-2' }, { id: 'facebook:2', platform: 'facebook', brand: 'bb-3' }] } as unknown as ChannelFile;
  assert.deepEqual(checkHolders(file, clients, 'bb-2', ['facebook:1', 'facebook:2'], own), { ok: false });
});
