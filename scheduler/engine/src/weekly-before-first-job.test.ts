import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProductBrands } from './product-brands.ts';
import { createReviewServer } from './review-server.ts';

const BB = 'brandbasket-secret-0123456789';
const OTHER = 'otherapp-secret-0123456789';

test('the weekly carousel can be switched on before the customer has any batch: the brand is claimed for her product and the flag is saved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weekly-first-'));
  const brands = join(root, 'brands');
  const server = createReviewServer({ brandsRoot: brands, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: BB }, { id: 'otherapp', secret: OTHER }], expiryDays: 0 });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, brand: string, body?: unknown, token = BB): Promise<Response> =>
    fetch(`${base}/review/carousel-weekly`, { method, headers: { Authorization: `Bearer ${token}`, 'X-Brand': brand, 'X-Actor': 'brandbasket:u1', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.deepEqual(await (await call('GET', 'bb-new')).json(), { enabled: false }, 'reading before anything exists is fine');
    const on = await call('PUT', 'bb-new', { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(await on.clone().json()));
    assert.deepEqual(await on.json(), { enabled: true });
    assert.equal(JSON.parse(readFileSync(join(brands, 'bb-new', 'carousel-weekly.json'), 'utf8')).enabled, true);
    assert.equal(new ProductBrands(brands).get('bb-new')?.productId, 'brandbasket');
    assert.deepEqual(await (await call('GET', 'bb-new')).json(), { enabled: true });
    assert.equal((await call('PUT', 'bb-new', { enabled: false })).status, 200, 'the same product can change it again');
    assert.equal((await call('PUT', 'bb-new', { enabled: true })).status, 200);
    // A bad value still changes nothing and makes no brand.
    assert.equal((await call('PUT', 'bb-bad', { enabled: 'yes' })).status, 400);
    // Another product cannot take a brand that already belongs to Brandbasket, and no folder is made for it.
    const taken = await call('PUT', 'bb-new', { enabled: false }, OTHER);
    assert.notEqual(taken.status, 200);
    assert.deepEqual(await (await call('GET', 'bb-new')).json(), { enabled: true });
    assert.equal(existsSync(join(brands, 'bb-bad', 'carousel-weekly.json')), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
