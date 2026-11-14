import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST as batchesPost } from '../api/_v1/batches.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { call, fakeEngine, OTHER_KEY, withProducts, type Answer, type FakeBatch, type FakeEngine } from '../dev/product-test-kit.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error']);
}

const DAY_MS = 86_400_000;
const istDay = (ahead: number): string => new Date(Date.now() + 5.5 * 3_600_000 + ahead * DAY_MS).toISOString().slice(0, 10);
const act = { 'x-social-actor': 'user_42' };
const post = (id: string, state: string, date: string, extra: Record<string, unknown> = {}) => ({ postId: id, headline: `Headline ${id}`, caption: 'Words', captions: { instagram: { text: 'Words' } }, state, date, ...extra });
const batch = (brand: string, posts: FakeBatch['posts'], over: Partial<FakeBatch> = {}): FakeBatch => ({ brand, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts, ...over });
const reset = (postId: unknown, headers: Record<string, string> = act, key?: string): Promise<Answer> => call(batchesPost, '/api/v1/batches', { headers, ...(key ? { key } : {}), json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'reset', postId } });
const stateOf = (answer: Answer, id: string): string | undefined => (answer.body['batch'] as { posts: Array<{ id: string; state: string }> }).posts.find((p) => p.id === id)?.state;

async function withEngine(run: (engine: FakeEngine, brand: string) => Promise<void>): Promise<void> {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'shop-1' } });
      await run(engine, String((made.body['workspace'] as { id: string }).id));
    } finally {
      await engine.close();
    }
  });
}

test('reset puts a kept or a dropped post back to undecided, as the named person, and answers the batch like keep and drop', async () => {
  await withEngine(async (engine, brand) => {
    engine.batches.push(batch(brand, [post('p1', 'kept', istDay(5)), post('p2', 'dropped', istDay(6)), post('p3', 'pending', istDay(7))]));
    const kept = await reset('p1');
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(stateOf(kept, 'p1'), 'pending');
    assert.deepEqual([engine.seen.at(-1)?.method, engine.seen.at(-1)?.url, engine.seen.at(-1)?.actor], ['POST', `/review/copy/${brand}/week-01.json/p1/reset`, 'brandbasket:user_42']);
    assert.equal(stateOf(await reset('p2'), 'p2'), 'pending', 'a dropped post too');
    assert.equal(stateOf(await reset('p3'), 'p3'), 'pending', 'an undecided one stays undecided');
  });
});

test('reset is refused with the API\'s own codes: a day that passed, a post already drawn, a dropped post with a new topic, no person, a bad post, another product', async () => {
  await withEngine(async (engine, brand) => {
    engine.batches.push(batch(brand, [post('p1', 'kept', istDay(-1)), post('p2', 'dropped', istDay(6), { replacedBy: 'p2r' })]));
    expectError(await reset('p1'), 400, 'DAY_PASSED', 'its day passed');
    expectError(await reset('p2'), 409, 'CONFLICT', 'a new topic stands in its place');
    expectError(await reset('p2', {}), 400, 'ACTOR_REQUIRED', 'no person named');
    expectError(await reset('nope'), 404, 'NOT_FOUND', 'no such post');
    expectError(await reset('p2', act, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    engine.batches[0]!.drawnAt = new Date().toISOString();
    expectError(await reset('p2'), 409, 'BATCH_LOCKED', 'already drawn');
  });
});
