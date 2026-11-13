import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as workspacesGet, PATCH as workspacesPatch, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { call, OTHER_KEY, withProducts, type Answer } from '../dev/product-test-kit.ts';
import { loadClients } from './store.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error']);
}

const make = (json: Record<string, unknown>, key?: string): Promise<Answer> => call(workspacesPost, '/api/v1/workspaces', { ...(key ? { key } : {}), json });
const rename = (json: unknown, key?: string): Promise<Answer> => call(workspacesPatch, '/api/v1/workspaces', { method: 'PATCH', ...(key ? { key } : {}), json });
const nameOf = (answer: Answer): unknown => (answer.body['workspace'] as Record<string, unknown>)['name'];

test('renaming a workspace changes the name that is shown, keeps everything else, and the new name is read back', async () => {
  await withProducts(async () => {
    const created = await make({ externalId: 'shop-1', name: 'Om Sweets' });
    assert.equal(created.status, 201);
    const before = created.body['workspace'] as Record<string, unknown>;
    const done = await rename({ externalId: 'shop-1', name: '  Om Sweets & Cafe  ' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const after = done.body['workspace'] as Record<string, unknown>;
    assert.equal(after['name'], 'Om Sweets & Cafe', 'trimmed');
    assert.deepEqual({ ...after, name: null }, { ...before, name: null }, 'only the name changes');
    assert.equal(nameOf(await call(workspacesGet, '/api/v1/workspaces?externalId=shop-1')), 'Om Sweets & Cafe');
    const again = await rename({ externalId: 'shop-1', name: 'Om Sweets & Cafe' });
    assert.equal(again.status, 200, 'the same name again is safe');
  });
});

test('a workspace made with no name can be given one, and a long name is cut at 80 characters', async () => {
  await withProducts(async () => {
    const created = await make({ externalId: 'shop-1' });
    assert.equal(nameOf(created), null);
    const done = await rename({ externalId: 'shop-1', name: 'x'.repeat(120) });
    assert.equal(nameOf(done), 'x'.repeat(80));
  });
});

test('a rename touches only that workspace of that product', async () => {
  await withProducts(async () => {
    await make({ externalId: 'shop-1', name: 'One' });
    await make({ externalId: 'shop-2', name: 'Two' });
    await rename({ externalId: 'shop-1', name: 'Uno' });
    assert.equal(nameOf(await call(workspacesGet, '/api/v1/workspaces?externalId=shop-2')), 'Two');
    expectError(await rename({ externalId: 'shop-1', name: 'Mine now' }, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    assert.equal(nameOf(await call(workspacesGet, '/api/v1/workspaces?externalId=shop-1')), 'Uno');
    const { file } = await loadClients();
    assert.equal(file.clients.filter((c) => c.name === 'Uno').length, 1);
  });
});

test('a brand that is put away can still be renamed', async () => {
  await withProducts(async () => {
    await make({ externalId: 'shop-1', name: 'Old' });
    const { file, etag } = await loadClients();
    const { saveClients } = await import('./store.ts');
    await saveClients({ clients: file.clients.map((c) => ({ ...c, archived: true as const })) }, etag);
    const done = await rename({ externalId: 'shop-1', name: 'New' });
    assert.equal(done.status, 200);
    assert.equal((done.body['workspace'] as Record<string, unknown>)['archived'], true);
  });
});

test('bad rename requests answer plainly', async () => {
  await withProducts(async () => {
    await make({ externalId: 'shop-1', name: 'Om Sweets' });
    expectError(await rename({ externalId: 'nobody', name: 'X' }), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
    expectError(await rename({ name: 'X' }), 400, 'INVALID_EXTERNAL_ID', 'no externalId');
    expectError(await rename({ externalId: 'bad id!', name: 'X' }), 400, 'INVALID_EXTERNAL_ID', 'bad externalId');
    for (const name of [undefined, null, 5, '', '   ']) expectError(await rename({ externalId: 'shop-1', name }), 400, 'INVALID_REQUEST', `name ${JSON.stringify(name)}`);
    expectError(await rename('not an object'), 400, 'INVALID_REQUEST', 'not an object');
    expectError(await call(workspacesPatch, '/api/v1/workspaces', { method: 'PATCH', key: null, json: { externalId: 'shop-1', name: 'X' } }), 401, 'UNAUTHORIZED', 'no key');
    const big = await call(workspacesPatch, '/api/v1/workspaces', { method: 'PATCH', headers: { 'content-length': '5000' }, json: { externalId: 'shop-1', name: 'X' } });
    expectError(big, 413, 'REQUEST_TOO_LARGE', 'too large');
    assert.equal(nameOf(await call(workspacesGet, '/api/v1/workspaces?externalId=shop-1')), 'Om Sweets', 'nothing changed');
  });
});
