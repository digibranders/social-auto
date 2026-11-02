import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addClient, allBrands, parseClientsFile, slugFor } from './clients.ts';

const NOW = Date.parse('2026-11-02T08:00:00Z');

test('a name becomes a plain slug: accents and punctuation go, words are joined by one dash', () => {
  assert.equal(slugFor('Brand Basket'), 'brand-basket');
  assert.equal(slugFor('  Café & Co.!! '), 'cafe-co');
  assert.equal(slugFor('A'.repeat(60)), 'a'.repeat(41));
  assert.throws(() => slugFor('***'), /letter or number/);
  assert.throws(() => slugFor(42), /name/);
});

test('adding a client keeps the others, and refuses a name that is already a client', () => {
  const first = addClient({ clients: [] }, 'Acme Dental', new Set(['brandbasket']), NOW);
  assert.equal(first.brand, 'acme-dental');
  assert.deepEqual(parseClientsFile(JSON.parse(JSON.stringify(first.file))), first.file);
  assert.throws(() => addClient(first.file, 'acme dental', new Set(), NOW), /already a client/);
  assert.throws(() => addClient({ clients: [] }, 'BrandBasket', new Set(['brandbasket']), NOW), /already a client/);
  const second = addClient(first.file, 'Zed', new Set(), NOW);
  assert.deepEqual(second.file.clients.map((c) => c.brand), ['acme-dental', 'zed']);
});

test('every planned and added client is known; a malformed file is rejected', () => {
  assert.deepEqual([...allBrands(['a'], { clients: [{ brand: 'b', createdAt: 'x' }] })].sort(), ['a', 'b']);
  assert.throws(() => parseClientsFile({}), /clients/);
  assert.throws(() => parseClientsFile({ clients: [{ brand: '../x', createdAt: 'x' }] }), /malformed/);
});
