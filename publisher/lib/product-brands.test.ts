import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST as archivePost } from '../api/_v1/workspace-archive.ts';
import { POST as batchesPost } from '../api/_v1/batches.ts';
import { POST as jobsPost } from '../api/_v1/site-jobs.ts';
import { POST as postersPost } from '../api/_v1/posters.ts';
import { GET as workspacesGet, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { brandsAllowed, brandsUsed, BRANDS_CEILING, MAX_WORKSPACES_PER_GROUP, BrandSettingsError, NO_BRAND_SETTINGS, parseBrandSettings, withDefaultBrands, withGroupBrands } from './brands.ts';
import { call, fakeEngine, OTHER_KEY, withProducts, type Answer } from '../dev/product-test-kit.ts';
import { loadBrandSettings, loadClients, loadPauses, saveBrandSettings, savePauses } from './store.ts';
import { setPause } from './pauses.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error']);
}

const NOW = Date.parse('2026-11-20T10:00:00Z');

test('how many brands a customer may have: the default, a value per customer, the ceiling in code, and a log of every change', () => {
  assert.equal(BRANDS_CEILING, 4);
  assert.equal(brandsAllowed(NO_BRAND_SETTINGS, 'brandbasket', 'biz-1'), 1);
  const wider = withDefaultBrands(NO_BRAND_SETTINGS, 2, 'owner', NOW);
  assert.deepEqual([brandsAllowed(wider, 'brandbasket', 'biz-1'), wider.log.length, wider.log[0]], [2, 1, { at: new Date(NOW).toISOString(), by: 'owner', what: 'default', old: 1, new: 2 }]);
  const one = withGroupBrands(wider, 'brandbasket', 'biz-1', 4, 'owner', NOW);
  assert.deepEqual([brandsAllowed(one, 'brandbasket', 'biz-1'), brandsAllowed(one, 'brandbasket', 'biz-2'), brandsAllowed(one, 'otherapp', 'biz-1')], [4, 2, 2], 'a value belongs to one product\'s one customer');
  assert.equal(withGroupBrands(one, 'brandbasket', 'biz-1', 4, 'owner', NOW), one, 'the same value is not a change and is not logged');
  const back = withGroupBrands(one, 'brandbasket', 'biz-1', null, 'owner', NOW);
  assert.deepEqual([brandsAllowed(back, 'brandbasket', 'biz-1'), back.log.at(-1)?.old, back.log.at(-1)?.new], [2, 4, null]);
  for (const bad of [0, 5, 2.5, '2', null, undefined]) assert.throws(() => withDefaultBrands(NO_BRAND_SETTINGS, bad, 'o', NOW), BrandSettingsError, String(bad));
  for (const bad of [0, 5, 2.5, '2', undefined]) assert.throws(() => withGroupBrands(NO_BRAND_SETTINGS, 'p', 'g', bad, 'o', NOW), BrandSettingsError, String(bad));
  assert.deepEqual(parseBrandSettings(JSON.parse(JSON.stringify(one))), one);
  assert.deepEqual(parseBrandSettings({}), NO_BRAND_SETTINGS);
  assert.throws(() => parseBrandSettings({ defaultBrands: 9 }), /1 to 4/);
  assert.throws(() => parseBrandSettings({ groups: { 'p:g': 7 } }), /1 to 4/);
  assert.equal(brandsUsed([{}, { archived: true }, {}]), 2, 'a brand put away does not count');
});

/** The team's setting for one customer, written the way the staff screen will write it. */
async function allow(group: string, value: number | null, product = 'brandbasket'): Promise<void> {
  const { settings, etag } = await loadBrandSettings();
  await saveBrandSettings(withGroupBrands(settings, product, group, value, 'test', NOW), etag);
}

const make = (json: Record<string, unknown>, key?: string): Promise<Answer> => call(workspacesPost, '/api/v1/workspaces', { ...(key ? { key } : {}), json });

test('a workspace belongs to a customer (group): brand 1 is its own group, later brands name the group, and a group never changes', async () => {
  await withProducts(async () => {
    await allow('biz-1', 4);
    const first = await make({ externalId: 'biz-1', name: 'Om Sweets' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const w1 = first.body['workspace'] as Record<string, unknown>;
    assert.deepEqual([w1['archived'], w1['group']], [false, { id: 'biz-1', brandsAllowed: 4, brandsUsed: 1 }]);
    const second = await make({ externalId: 'biz-1:cafe0001', name: 'Om Cafe', group: 'biz-1' });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.deepEqual((second.body['workspace'] as Record<string, unknown>)['group'], { id: 'biz-1', brandsAllowed: 4, brandsUsed: 2 });
    // The same group again for brand 1 is fine; saying brand 1 belongs to another customer is a mistake.
    assert.equal((await make({ externalId: 'biz-1', group: 'biz-1' })).status, 200);
    expectError(await make({ externalId: 'biz-1', group: 'biz-2' }), 409, 'GROUP_MISMATCH', 'a brand cannot move to another customer');
    expectError(await make({ externalId: 'biz-1:cafe0001', group: 'biz-2' }), 409, 'GROUP_MISMATCH', 'nor a later brand');
    expectError(await make({ externalId: 'biz-3', group: 'bad group!' }), 400, 'INVALID_GROUP', 'a bad group');
    expectError(await make({ externalId: 'biz-3', group: 5 }), 400, 'INVALID_GROUP', 'a group that is not text');
  });
});

test('GET /api/v1/workspaces?group= lists only this product\'s workspaces of that customer, with how many brands are allowed and used', async () => {
  await withProducts(async () => {
    await allow('biz-1', 2);
    await make({ externalId: 'biz-1', name: 'Om Sweets' });
    await make({ externalId: 'biz-1:cafe0001', name: 'Om Cafe', group: 'biz-1' });
    await make({ externalId: 'biz-2', name: 'Other customer' });
    await make({ externalId: 'biz-1', name: 'Same id, another product' }, OTHER_KEY);
    const read = await call(workspacesGet, '/api/v1/workspaces?group=biz-1');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual((read.body['workspaces'] as Array<Record<string, unknown>>).map((w) => [w['externalId'], w['name'], w['archived']]), [['biz-1', 'Om Sweets', false], ['biz-1:cafe0001', 'Om Cafe', false]]);
    assert.deepEqual([read.body['brandsAllowed'], read.body['brandsUsed'], read.body['ceiling']], [2, 2, 4]);
    assert.deepEqual(Object.keys((read.body['workspaces'] as object[])[0] as object).sort(), ['archived', 'externalId', 'id', 'name', 'website']);
    // Another product sees only its own workspace under the same group id, and an unknown group is an empty list with the default allowance.
    const other = await call(workspacesGet, '/api/v1/workspaces?group=biz-1', { key: OTHER_KEY });
    assert.deepEqual((other.body['workspaces'] as Array<Record<string, unknown>>).map((w) => w['name']), ['Same id, another product']);
    assert.deepEqual((await call(workspacesGet, '/api/v1/workspaces?group=nobody')).body, { workspaces: [], brandsAllowed: 1, brandsUsed: 0, ceiling: 4 });
    expectError(await call(workspacesGet, '/api/v1/workspaces?group=bad%20group'), 400, 'INVALID_GROUP', 'a bad group');
    expectError(await call(workspacesGet, '/api/v1/workspaces'), 400, 'INVALID_EXTERNAL_ID', 'neither id nor group');
    expectError(await call(workspacesGet, '/api/v1/workspaces?group=biz-1', { key: null }), 401, 'UNAUTHORIZED', 'no key');
    // The workspace read says the same about its customer.
    const w = (await call(workspacesGet, '/api/v1/workspaces?externalId=biz-1:cafe0001')).body['workspace'] as Record<string, unknown>;
    assert.deepEqual(w['group'], { id: 'biz-1', brandsAllowed: 2, brandsUsed: 2 });
  });
});

test('a customer cannot have more brands than they are allowed: the default is 1, the team can allow more up to the ceiling, and the sentence is plain', async () => {
  await withProducts(async () => {
    assert.equal((await make({ externalId: 'biz-1', name: 'One' })).status, 201);
    const refused = await make({ externalId: 'biz-1:brand002', name: 'Two', group: 'biz-1' });
    expectError(refused, 409, 'BRAND_LIMIT_REACHED', 'the default is one brand');
    assert.equal(refused.body['error'], 'You can have 1 brand. Ask us to allow more.');
    assert.equal(((await call(workspacesGet, '/api/v1/workspaces?group=biz-1')).body['workspaces'] as unknown[]).length, 1, 'nothing was made');
    // Repeating a create for a brand that exists is not a new brand, even when the customer is at the limit.
    assert.equal((await make({ externalId: 'biz-1', name: 'One', group: 'biz-1' })).status, 200);

    await allow('biz-1', 3);
    assert.equal((await make({ externalId: 'biz-1:brand002', name: 'Two', group: 'biz-1' })).status, 201);
    assert.equal((await make({ externalId: 'biz-1:brand003', name: 'Three', group: 'biz-1' })).status, 201);
    const third = await make({ externalId: 'biz-1:brand004', name: 'Four', group: 'biz-1' });
    expectError(third, 409, 'BRAND_LIMIT_REACHED', 'three allowed');
    assert.equal(third.body['error'], 'You can have 3 brands. Ask us to allow more.');
    assert.deepEqual([(await call(workspacesGet, '/api/v1/workspaces?group=biz-1')).body['brandsUsed']], [3]);

    // Another customer and another product have their own allowance (the default).
    assert.equal((await make({ externalId: 'biz-2', name: 'Someone else' })).status, 201);
    expectError(await make({ externalId: 'biz-2:brand002', group: 'biz-2' }), 409, 'BRAND_LIMIT_REACHED', 'another customer is at the default');
    assert.equal((await make({ externalId: 'biz-1:brand002', group: 'biz-1' }, OTHER_KEY)).status, 201, 'the same ids in another product are a different customer');
    // Lowering the allowance deletes nothing, and blocks only new brands.
    await allow('biz-1', 1);
    assert.deepEqual((await call(workspacesGet, '/api/v1/workspaces?group=biz-1')).body['brandsAllowed'], 1);
    expectError(await make({ externalId: 'biz-1:brand005', group: 'biz-1' }), 409, 'BRAND_LIMIT_REACHED', 'over the lowered allowance');
    assert.equal(((await call(workspacesGet, '/api/v1/workspaces?group=biz-1')).body['workspaces'] as unknown[]).length, 3);
    // The ceiling is in code: even a stored value above it is refused before it can be used.
    const { settings } = await loadBrandSettings();
    assert.throws(() => withGroupBrands(settings, 'brandbasket', 'biz-1', BRANDS_CEILING + 1, 'owner', NOW), BrandSettingsError);
  });
});

const archive = (externalId: string, archived: boolean, key?: string): Promise<Answer> => call(archivePost, '/api/v1/workspaces/archive', { ...(key ? { key } : {}), json: { externalId, archived } });

test('putting a brand away pauses it and frees a slot; bringing it back needs a free slot and lifts only the pause it made', async () => {
  await withProducts(async () => {
    await allow('biz-1', 2);
    await make({ externalId: 'biz-1', name: 'One' });
    await make({ externalId: 'biz-1:brand002', name: 'Two', group: 'biz-1' });
    expectError(await make({ externalId: 'biz-1:brand003', group: 'biz-1' }), 409, 'BRAND_LIMIT_REACHED', 'full');

    const away = await archive('biz-1:brand002', true);
    assert.equal(away.status, 200, JSON.stringify(away.body));
    const w = away.body['workspace'] as Record<string, unknown>;
    assert.deepEqual([w['archived'], w['paused']], [true, true]);
    assert.deepEqual((await call(workspacesGet, '/api/v1/workspaces?group=biz-1')).body['brandsUsed'], 1);
    assert.equal((await archive('biz-1:brand002', true)).status, 200, 'doing it again is safe');
    assert.equal((await make({ externalId: 'biz-1:brand003', name: 'Three', group: 'biz-1' })).status, 201, 'the slot is free');
    // It is full again, so the brand put away cannot come back until another is put away.
    expectError(await archive('biz-1:brand002', false), 409, 'BRAND_LIMIT_REACHED', 'no free slot to come back to');
    assert.equal((await archive('biz-1:brand003', true)).status, 200);
    const back = await archive('biz-1:brand002', false);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.deepEqual([(back.body['workspace'] as Record<string, unknown>)['archived'], (back.body['workspace'] as Record<string, unknown>)['paused']], [false, false]);
    assert.equal((await archive('biz-1:brand002', false)).status, 200, 'and again');

    // A pause the team made is not lifted when a brand comes back.
    const { client } = { client: (await loadClients()).file.clients.find((c) => c.externalId === 'biz-1') as { brand: string } };
    const { file: pauses, etag } = await loadPauses();
    await savePauses(setPause(pauses, 'brand', client.brand, true), etag);
    assert.equal((await archive('biz-1', true)).status, 200);
    await archive('biz-1:brand003', false).catch(() => undefined);
    await archive('biz-1', false);
    assert.equal((await loadPauses()).file.brands.includes(client.brand), true, 'the team\'s pause stays');

    // Errors, and tenancy.
    expectError(await archive('nobody', true), 404, 'WORKSPACE_NOT_FOUND', 'no such brand');
    expectError(await archive('biz-1', true, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product\'s brand');
    expectError(await call(archivePost, '/api/v1/workspaces/archive', { json: { externalId: 'biz-1' } }), 400, 'INVALID_REQUEST', 'archived must be said');
    expectError(await call(archivePost, '/api/v1/workspaces/archive', { json: { archived: true } }), 400, 'INVALID_EXTERNAL_ID', 'no externalId');
    expectError(await call(archivePost, '/api/v1/workspaces/archive', { key: null, json: { externalId: 'biz-1', archived: true } }), 401, 'UNAUTHORIZED', 'no key');
  });
});

test('a customer\'s group can never hold more than the most workspaces, however many are put away', async () => {
  await withProducts(async () => {
    await allow('biz-1', 4);
    await make({ externalId: 'biz-1', name: 'One' });
    for (let n = 2; n <= MAX_WORKSPACES_PER_GROUP; n += 1) {
      const id = `biz-1:brand${String(n).padStart(3, '0')}`;
      assert.equal((await make({ externalId: id, group: 'biz-1' })).status, 201, id);
      assert.equal((await archive(id, true)).status, 200);
    }
    const last = await make({ externalId: 'biz-1:brand999', group: 'biz-1' });
    expectError(last, 409, 'BRAND_LIMIT_REACHED', 'the lifetime cap');
    assert.match(String(last.body['error']), /most brands that can ever be set up/);
  });
});

test('a brand that is put away writes, draws and spends nothing, but can still be read', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await allow('biz-1', 2);
      await make({ externalId: 'biz-1', name: 'One' });
      await archive('biz-1', true);
      const before = engine.seen.length;
      expectError(await call(jobsPost, '/api/v1/site-jobs', { json: { externalId: 'biz-1', site: 'https://acme.example.com' } }), 409, 'WORKSPACE_ARCHIVED', 'a new batch');
      const act = { 'x-social-actor': 'user_1' };
      for (const json of [{ action: 'draw', batchId: 'week-01.json' }, { action: 'add-network', batchId: 'week-01.json', network: 'facebook' }]) {
        expectError(await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'biz-1', ...json } }), 409, 'WORKSPACE_ARCHIVED', JSON.stringify(json));
      }
      expectError(await call(postersPost, '/api/v1/posters', { headers: act, json: { externalId: 'biz-1', action: 'redraw', id: 'x.0000000000000001' } }), 409, 'WORKSPACE_ARCHIVED', 'a redraw');
      assert.equal(engine.seen.length, before, 'nothing reached the engine');
      assert.equal((await call(workspacesGet, '/api/v1/workspaces?externalId=biz-1')).status, 200, 'it can still be read');
    } finally {
      await engine.close();
    }
  });
});
