import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureWorkspace, findWorkspace, isBrandSlug, workspaceBrand } from './clients.ts';
import { authenticateProduct, hashKey, isReturnUrl, parseProducts } from './products.ts';

const KEY_A = 'sk_live_aaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'sk_live_bbbbbbbbbbbbbbbbbbbbbbbb';
const products = parseProducts(
  JSON.stringify([
    { id: 'brandbasket', keyHash: hashKey(KEY_A), returnUrls: ['https://app.brandbasket.in/social'], webhookUrl: 'https://app.brandbasket.in/api/webhooks/social', webhookSecret: 'x'.repeat(20) },
    { id: 'firstfold', keyHash: hashKey(KEY_B) },
  ]),
);
const request = (key?: string): Request => new Request('https://x/api', { headers: key === undefined ? {} : { authorization: key } });

test('a request is matched to its product by key, and a wrong, missing or malformed key matches none', () => {
  assert.equal(authenticateProduct(request(`Bearer ${KEY_A}`), products)?.id, 'brandbasket');
  assert.equal(authenticateProduct(request(`Bearer ${KEY_B}`), products)?.id, 'firstfold');
  assert.equal(authenticateProduct(request('Bearer nope'), products), null);
  assert.equal(authenticateProduct(request(KEY_A), products), null);
  assert.equal(authenticateProduct(request(), products), null);
  assert.equal(authenticateProduct(request(`Bearer ${'a'.repeat(300)}`), products), null);
  assert.equal(authenticateProduct(request(`Bearer ${KEY_A}`), []), null);
});

test('product settings are checked strictly: ids, hashes, addresses and webhook secrets', () => {
  const ok = { id: 'acme', keyHash: hashKey('k') };
  assert.deepEqual(parseProducts(undefined), []);
  assert.throws(() => parseProducts('{'), /valid JSON/);
  assert.throws(() => parseProducts('{}'), /list/);
  assert.throws(() => parseProducts(JSON.stringify([{ ...ok, id: 'Bad Id' }])), /id must be/);
  assert.throws(() => parseProducts(JSON.stringify([ok, ok])), /used twice/);
  assert.throws(() => parseProducts(JSON.stringify([{ ...ok, keyHash: 'plain-key' }])), /SHA-256/);
  assert.throws(() => parseProducts(JSON.stringify([{ ...ok, returnUrls: ['http://evil.example/x'] }])), /https/);
  assert.doesNotThrow(() => parseProducts(JSON.stringify([{ ...ok, returnUrls: ['http://localhost:3198/social'] }])));
  assert.throws(() => parseProducts(JSON.stringify([{ ...ok, webhookUrl: 'https://a.example/w' }])), /webhookSecret/);
  assert.equal(isReturnUrl(products[0]!, 'https://app.brandbasket.in/social'), true);
  assert.equal(isReturnUrl(products[0]!, 'https://app.brandbasket.in/other'), false);
  assert.equal(isReturnUrl(products[1]!, 'https://app.brandbasket.in/social'), false);
});

test('a workspace is created once per customer, repeats return the same one, and products never share', () => {
  const NOW = Date.parse('2026-11-02T08:00:00Z');
  const first = ensureWorkspace({ clients: [] }, 'brandbasket', 'biz_123', '  Sunrise Bakery ', NOW);
  assert.equal(first.created, true);
  assert.equal(first.client.name, 'Sunrise Bakery');
  assert.equal(isBrandSlug(first.client.brand), true);
  assert.match(first.client.brand, /^brandbasket-biz-123-[0-9a-f]{6}$/);
  const again = ensureWorkspace(first.file, 'brandbasket', 'biz_123', 'Other name', NOW);
  assert.equal(again.created, false);
  assert.equal(again.client.brand, first.client.brand);
  const other = ensureWorkspace(first.file, 'firstfold', 'biz_123', 'Same id, other product', NOW);
  assert.equal(other.created, true);
  assert.notEqual(other.client.brand, first.client.brand);
  assert.equal(findWorkspace(other.file, 'brandbasket', 'biz_123')?.brand, first.client.brand);
  assert.equal(findWorkspace(first.file, 'firstfold', 'biz_123'), undefined);
});

test('workspace ids stay valid for long and odd customer ids, and bad ids are refused', () => {
  assert.equal(isBrandSlug(workspaceBrand('brandbasket', 'a'.repeat(64))), true);
  assert.equal(isBrandSlug(workspaceBrand('brandbasket', '***')), true);
  assert.notEqual(workspaceBrand('brandbasket', 'A-1'), workspaceBrand('brandbasket', 'a-1'));
  assert.throws(() => ensureWorkspace({ clients: [] }, 'brandbasket', '../x', 'n', 0), /externalId/);
  assert.throws(() => ensureWorkspace({ clients: [] }, 'brandbasket', '', 'n', 0), /externalId/);
});
