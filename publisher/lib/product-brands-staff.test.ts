import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST as clientsPost } from '../api/clients.ts';
import { GET as workspacesGet, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, withProducts } from '../dev/product-test-kit.ts';
import { brandsFeed, NO_BRAND_SETTINGS, withDefaultBrands, withGroupBrands } from './brands.ts';
import type { ClientsFile } from './clients.ts';
import { loadBrandSettings } from './store.ts';

const NOW = Date.parse('2026-11-20T10:00:00Z');
const clients: ClientsFile = {
  clients: [
    { brand: 'brandbasket-biz-1-a', createdAt: '2026-11-01T00:00:00.000Z', product: 'brandbasket', externalId: 'biz-1', name: 'Om Sweets' },
    { brand: 'brandbasket-biz-1-cafe-b', createdAt: '2026-11-02T00:00:00.000Z', product: 'brandbasket', externalId: 'biz-1:cafe0001', group: 'biz-1', name: 'Om Cafe', archived: true },
    { brand: 'brandbasket-biz-2-c', createdAt: '2026-11-03T00:00:00.000Z', product: 'brandbasket', externalId: 'biz-2', name: 'Asha Salon' },
    { brand: 'mine', createdAt: '2026-11-01T00:00:00.000Z', name: 'Our own client' },
  ],
};

test('the staff feed lists each product customer with their allowance and use, the default and the latest changes', () => {
  let settings = withDefaultBrands(NO_BRAND_SETTINGS, 2, 'owner', NOW);
  settings = withGroupBrands(settings, 'brandbasket', 'biz-1', 4, 'owner', NOW + 1000);
  const feed = brandsFeed(settings, clients);
  assert.deepEqual([feed.defaultBrands, feed.ceiling], [2, 4]);
  assert.deepEqual(feed.customers, [
    { product: 'brandbasket', group: 'biz-2', name: 'Asha Salon', brandsAllowed: 2, brandsUsed: 1, brandsTotal: 1, custom: false },
    { product: 'brandbasket', group: 'biz-1', name: 'Om Sweets', brandsAllowed: 4, brandsUsed: 1, brandsTotal: 2, custom: true },
  ]);
  assert.deepEqual(feed.log.map((l) => [l.what, l.old, l.new]), [['brandbasket:biz-1', null, 4], ['default', 1, 2]], 'newest first, our own clients are not customers');
});

const staff = (action: string, json: unknown, secret: string | null = 'staff-secret-for-tests'): Promise<{ status: number; body: Record<string, unknown> }> =>
  clientsPost(new Request(`https://social.example.test/api/clients?action=${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(json) })).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

test('the team sets the default and one customer\'s number from the dashboard; the ceiling and who may do it are checked on the server, and the product sees it at once', async () => {
  await withProducts(async () => {
    const before = process.env['EDIT_SECRET'];
    process.env['EDIT_SECRET'] = 'staff-secret-for-tests';
    try {
      await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'biz-1', name: 'Om Sweets' } });
      const read = async (): Promise<Record<string, unknown>> => (await call(workspacesGet, '/api/v1/workspaces?group=biz-1')).body;
      assert.equal((await read())['brandsAllowed'], 1);

      assert.equal((await staff('set-brands-default', { value: 2 })).status, 200);
      assert.equal((await read())['brandsAllowed'], 2, 'the product sees the default at once');
      assert.equal((await staff('set-brands-allowed', { product: 'brandbasket', group: 'biz-1', value: 3 })).status, 200);
      assert.equal((await read())['brandsAllowed'], 3);
      assert.equal((await staff('set-brands-allowed', { product: 'brandbasket', group: 'biz-1', value: null })).status, 200);
      assert.equal((await read())['brandsAllowed'], 2, 'back on the default');

      // The ceiling is checked here, not only on a screen.
      for (const value of [0, 5, 2.5, '3', undefined]) {
        const refused = await staff('set-brands-default', { value });
        assert.equal(refused.status, 400, String(value));
        assert.match(String(refused.body['error']), /1 to 4/);
      }
      assert.equal((await staff('set-brands-allowed', { product: 'brandbasket', group: 'biz-1', value: 9 })).status, 400);
      assert.equal((await staff('set-brands-allowed', { product: 'brandbasket', group: 'nobody', value: 2 })).status, 404, 'no such customer');
      assert.equal((await staff('set-brands-allowed', { product: 'other app!', group: 'biz-1', value: 2 })).status, 400);
      assert.equal((await staff('set-brands-allowed', { product: 'otherapp', group: 'biz-1', value: 2 })).status, 404, 'a customer of another product is not this one');
      assert.equal((await staff('set-brands-default', { value: 3 }, null)).status, 401, 'only the dashboard may');
      assert.equal((await staff('set-brands-default', { value: 3 }, 'wrong-secret-for-tests')).status, 401);
      assert.equal((await read())['brandsAllowed'], 2, 'nothing changed by the refused calls');

      const { settings } = await loadBrandSettings();
      assert.deepEqual(settings.log.map((l) => [l.by, l.what, l.old, l.new]), [['owner', 'default', 1, 2], ['owner', 'brandbasket:biz-1', null, 3], ['owner', 'brandbasket:biz-1', 3, null]], 'every change is logged with who');
    } finally {
      if (before === undefined) delete process.env['EDIT_SECRET'];
      else process.env['EDIT_SECRET'] = before;
    }
  });
});
