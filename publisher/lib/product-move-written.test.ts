import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST as batchesPost } from '../api/_v1/batches.ts';
import { POST as archivePost } from '../api/_v1/workspace-archive.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { call, fakeEngine, OTHER_KEY, withProducts, type Answer, type FakeBatch, type FakeEngine } from '../dev/product-test-kit.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error']);
  assert.doesNotMatch(JSON.stringify(answer.body), /\/home|ENOENT/, `${label}: nothing of the engine's own words`);
}

const DAY_MS = 86_400_000;
const monday = ((): string => { const d = new Date(Date.now() + 5.5 * 3_600_000 + 10 * DAY_MS); while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const dayOf = (n: number): string => new Date(Date.parse(`${monday}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const act = { 'x-social-actor': 'user_42' };
const post = (id: string, state: string, date: string, caption = 'Words') => ({ postId: id, headline: `Headline ${id}`, caption, captions: { instagram: { text: caption } }, state, date });
const batch = (brand: string, posts: FakeBatch['posts'], over: Partial<FakeBatch> = {}): FakeBatch => ({ brand, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts, ...over });
const move = (postId: string, day: unknown, over: Record<string, unknown> = {}, headers: Record<string, string> = act, key?: string): Promise<Answer> => call(batchesPost, '/api/v1/batches', { headers, ...(key ? { key } : {}), json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'move', postId, day, ...over } });

async function workspace(externalId: string): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId, name: externalId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return String((made.body['workspace'] as { id: string }).id);
}

async function withEngine(run: (engine: FakeEngine) => Promise<void>): Promise<void> {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      await run(engine);
    } finally {
      await engine.close();
    }
  });
}

test('a written post moves to another day of its own week, whatever its state; the answer is the batch, and a day it already has changes nothing', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    engine.batches.push(batch(brand, [post('p0', 'pending', dayOf(0)), post('p1', 'kept', dayOf(1)), post('p2', 'dropped', dayOf(2))]));
    for (const [id, to] of [['p0', dayOf(4)], ['p1', dayOf(6)], ['p2', dayOf(5)]] as const) {
      const done = await move(id, to);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      const posts = (done.body['batch'] as { posts: Array<{ id: string; date: string; state: string }> }).posts;
      assert.equal(posts.find((p) => p.id === id)?.date, to, `${id} is on its new day`);
      assert.equal(done.body['warnings'], undefined, 'no warning when the words name no day');
    }
    assert.deepEqual([engine.seen.at(-1)?.method, engine.seen.at(-1)?.url, engine.seen.at(-1)?.body, engine.seen.at(-1)?.actor], ['POST', `/review/copy/${brand}/week-01.json/p2/move`, { day: dayOf(5) }, 'brandbasket:user_42']);
    const same = await move('p0', dayOf(4));
    assert.equal(same.status, 200, 'the day it already has is a 200');
  });
});

test('a moved post whose words name a day is flagged, because the words are not rewritten', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    engine.batches.push(batch(brand, [post('p0', 'pending', dayOf(0), 'Come on Friday for the special')]));
    const done = await move('p0', dayOf(2));
    assert.equal(done.status, 200);
    assert.deepEqual(done.body['warnings'], ['WORDS_NAME_A_DAY']);
  });
});

test('a move is refused plainly: a bad day, another week, a day that has passed, a week that was drawn, no such post, a brand put away, no person named', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    const passed = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    engine.batches.push(batch(brand, [post('p0', 'pending', dayOf(0)), post('p9', 'pending', new Date(Date.now() + 5.5 * 3_600_000 + DAY_MS).toISOString().slice(0, 10))]));
    for (const bad of ['tomorrow', '2026-13-40', '2026-02-31', 42, null, undefined]) expectError(await move('p0', bad), 400, 'INVALID_DAY', `day ${JSON.stringify(bad)}`);
    expectError(await move('p0', dayOf(7)), 400, 'INVALID_DAY', 'the next week');
    expectError(await move('p0', dayOf(-1)), 400, 'INVALID_DAY', 'the week before');
    const sameWeek = new Date(`${passed}T00:00:00Z`).getUTCDay() !== 0;
    if (sameWeek) expectError(await move('p9', passed), 400, 'DAY_PASSED', 'today');
    expectError(await move('nope', dayOf(2)), 404, 'NOT_FOUND', 'no such post');
    expectError(await move('p0', dayOf(2), { batchId: 'week-09.json' }), 404, 'NOT_FOUND', 'no such batch');
    expectError(await move('p0', dayOf(2), {}, {}), 400, 'ACTOR_REQUIRED', 'no person named');
    expectError(await move('p0', dayOf(2), {}, act, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    expectError(await move(undefined as never, dayOf(2)), 400, 'INVALID_REQUEST', 'no post named');
    (engine.batches[0] as FakeBatch).drawnAt = '2026-11-12T00:00:00Z';
    expectError(await move('p0', dayOf(2)), 409, 'BATCH_LOCKED', 'a week that was drawn');
    delete (engine.batches[0] as { drawnAt?: string }).drawnAt;
    const away = await call(archivePost, '/api/v1/workspaces/archive', { json: { externalId: 'shop-1', archived: true } });
    assert.equal(away.status, 200);
    expectError(await move('p0', dayOf(2)), 409, 'WORKSPACE_ARCHIVED', 'put away');
  });
});
