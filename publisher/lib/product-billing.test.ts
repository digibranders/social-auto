import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST as billingPost } from '../api/_v1/workspace-billing.ts';
import { POST as batchesPost } from '../api/_v1/batches.ts';
import { POST as jobsPost } from '../api/_v1/site-jobs.ts';
import { POST as postersPost } from '../api/_v1/posters.ts';
import { GET as workspacesGet, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { call, fakeEngine, OTHER_KEY, withProducts, type Answer } from '../dev/product-test-kit.ts';
import type { ClientsFile } from './clients.ts';
import { NO_PAUSES, setBilling } from './pauses.ts';
import { problemEvents } from './product-watch.ts';
import { loadPauses } from './store.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
}

const today = (): string => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const plusDays = (n: number): string => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const make = (externalId: string, key?: string): Promise<Answer> => call(workspacesPost, '/api/v1/workspaces', { ...(key ? { key } : {}), json: { externalId, name: 'Om Sweets' } });
const billing = (json: Record<string, unknown>, key?: string, actor = true): Promise<Answer> => call(billingPost, '/api/v1/workspaces/billing', { ...(key ? { key } : {}), ...(actor ? { headers: { 'x-social-actor': 'user_1' } } : {}), json });
const read = async (externalId: string): Promise<Record<string, unknown>> => (await call(workspacesGet, `/api/v1/workspaces?externalId=${externalId}`)).body['workspace'] as Record<string, unknown>;

test('the product says when posting stops: the workspace shows the date, the last day and a notice, and clearing it puts everything back', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await make('biz-1');
      assert.deepEqual((await read('biz-1'))['billing'], { endDate: null, lastPostingDay: null, state: 'none' });

      const end = plusDays(8);
      const set = await billing({ externalId: 'biz-1', endDate: end });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      const workspace = set.body['workspace'] as Record<string, unknown>;
      assert.deepEqual(workspace['billing'], { endDate: end, lastPostingDay: plusDays(7), state: 'ending' });
      assert.deepEqual((workspace['notices'] as Array<{ code: string }>).map((n) => n.code), ['PLAN_ENDING']);
      assert.equal(workspace['paused'], false, 'still posting until the day before');
      assert.equal(engine.billingEnd, end, 'the poster service was told');

      // The same date again changes nothing (and is safe); a later date is a renewal; null is "keep my plan".
      assert.equal((await billing({ externalId: 'biz-1', endDate: end })).status, 200);
      const pauses = (await loadPauses()).file;
      assert.equal(Object.keys(pauses.billing ?? {}).length, 1);
      const renewed = await billing({ externalId: 'biz-1', endDate: plusDays(38) });
      assert.equal(((renewed.body['workspace'] as Record<string, unknown>)['billing'] as Record<string, unknown>)['endDate'], plusDays(38));
      const cleared = await billing({ externalId: 'biz-1', endDate: null });
      assert.deepEqual((cleared.body['workspace'] as Record<string, unknown>)['billing'], { endDate: null, lastPostingDay: null, state: 'none' });
      assert.equal(engine.billingEnd, null);
    } finally {
      await engine.close();
    }
  });
});

test('a date that has already come stops posting at once, says so, and only that customer is affected', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await make('biz-1');
      await make('biz-2');
      const done = await billing({ externalId: 'biz-1', endDate: today() });
      const workspace = done.body['workspace'] as Record<string, unknown>;
      assert.equal((workspace['billing'] as Record<string, unknown>)['state'], 'ended');
      assert.equal(workspace['paused'], true);
      assert.deepEqual((workspace['notices'] as Array<{ code: string }>).map((n) => n.code), ['PLAN_ENDED']);
      assert.equal(((await read('biz-2'))['billing'] as Record<string, unknown>)['state'], 'none');
    } finally {
      await engine.close();
    }
  });
});

test('after the date every call that spends money or sends answers 409 PLAN_ENDED and nothing reaches the poster service; reads still work', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await make('biz-1');
      await billing({ externalId: 'biz-1', endDate: today() });
      const before = engine.seen.length;
      expectError(await call(jobsPost, '/api/v1/site-jobs', { json: { externalId: 'biz-1', site: 'https://acme.example.com' } }), 409, 'PLAN_ENDED', 'a new batch');
      const act = { 'x-social-actor': 'user_1' };
      expectError(await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'biz-1', action: 'draw', batchId: 'week-01.json' } }), 409, 'PLAN_ENDED', 'a draw');
      expectError(await call(postersPost, '/api/v1/posters', { headers: act, json: { externalId: 'biz-1', action: 'redraw', id: 'x.0000000000000001' } }), 409, 'PLAN_ENDED', 'a redraw');
      assert.equal(engine.seen.length, before, 'nothing reached the engine');
      assert.equal((await call(workspacesGet, '/api/v1/workspaces?externalId=biz-1')).status, 200);
      // Keeping the plan opens it again: the same call now gets past the check (the fake engine answers).
      await billing({ externalId: 'biz-1', endDate: null });
      const again = await call(jobsPost, '/api/v1/site-jobs', { json: { externalId: 'biz-1', site: 'https://acme.example.com' } });
      assert.notEqual(again.body['code'], 'PLAN_ENDED');
    } finally {
      await engine.close();
    }
  });
});

test('the call is checked: a real day or null, a workspace of this product only, and the product key', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await make('biz-1');
      expectError(await billing({ externalId: 'biz-1', endDate: '2026-02-30' }), 400, 'INVALID_END_DATE', 'not a real day');
      expectError(await billing({ externalId: 'biz-1', endDate: 'soon' }), 400, 'INVALID_END_DATE', 'not a date');
      expectError(await billing({ externalId: 'biz-1' }), 400, 'INVALID_END_DATE', 'no date at all is not the same as null');
      expectError(await billing({ endDate: '2026-12-10' }), 400, 'INVALID_EXTERNAL_ID', 'no externalId');
      expectError(await billing({ externalId: 'nobody', endDate: '2026-12-10' }), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
      // Another product cannot reach this product's workspace, and its own workspace of the same id is a different one.
      expectError(await billing({ externalId: 'biz-1', endDate: '2026-12-10' }, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
      assert.equal((await call(billingPost, '/api/v1/workspaces/billing', { key: null, json: { externalId: 'biz-1', endDate: null } })).status, 401);
      assert.equal(engine.billingEnd, null, 'nothing was changed by the refused calls');
    } finally {
      await engine.close();
    }
  });
});

const clients: ClientsFile = { clients: [{ brand: 'brandbasket-shop-1-abc123', createdAt: 'x', product: 'brandbasket', externalId: 'shop-1', website: 'https://acme.example.com' }, { brand: 'mine', createdAt: 'x', website: 'https://mine.example.com' }] };

test('the product hears once, for each billing date, that posting stopped; our own clients are never announced', () => {
  const ended = setBilling(setBilling(NO_PAUSES, 'brandbasket-shop-1-abc123', '2026-12-10', 'u', 'x'), 'mine', '2026-12-10', 'u', 'x');
  const before = problemEvents([], { channels: [] }, {}, ended, clients, { announced: [] }, Date.parse('2026-12-09T20:00:00+05:30'));
  assert.deepEqual(before.items, [], 'nothing before the date');
  const after = problemEvents([], { channels: [] }, {}, ended, clients, { announced: [] }, Date.parse('2026-12-10T00:05:00+05:30'));
  assert.deepEqual(after.items.map((i) => [i.event.type, i.product, i.event.data]), [['workspace.plan_ended', 'brandbasket', { externalId: 'shop-1', endDate: '2026-12-10', lastPostingDay: '2026-12-09' }]]);
  assert.deepEqual(problemEvents([], { channels: [] }, {}, ended, clients, { announced: after.announced }, Date.parse('2026-12-11T10:00:00+05:30')).items, [], 'not twice');
  // After a renewal the new date is announced when it comes.
  const renewed = setBilling(ended, 'brandbasket-shop-1-abc123', '2027-01-10', 'u', 'x');
  assert.equal(problemEvents([], { channels: [] }, {}, renewed, clients, { announced: after.announced }, Date.parse('2027-01-10T00:05:00+05:30')).items.length, 1);
});
