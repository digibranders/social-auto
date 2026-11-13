import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as batchesGet, POST as batchesPost } from '../api/_v1/batches.ts';
import { POST as archivePost } from '../api/_v1/workspace-archive.ts';
import { GET as jobsGet } from '../api/_v1/site-jobs.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { call, fakeEngine, OTHER_KEY, withProducts, type Answer, type FakeBatch, type FakeEngine } from '../dev/product-test-kit.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.doesNotMatch(JSON.stringify(answer.body), /\/home|ENOENT/, `${label}: nothing of the engine's own words`);
}

const day = (ahead: number): string => new Date(Date.now() + 5.5 * 3_600_000 + ahead * 86_400_000).toISOString().slice(0, 10);
const act = { 'x-social-actor': 'user_42' };
const post = (id: string, state: string, date: string, extra: Record<string, unknown> = {}) => ({ postId: id, headline: `Headline ${id}`, caption: 'Words', captions: { instagram: { text: 'ig' } }, state, date, ...extra });
const batch = (brand: string, posts: FakeBatch['posts'], over: Partial<FakeBatch> = {}): FakeBatch => ({ brand, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts, ...over });
const replace = (postId: string, over: Record<string, unknown> = {}, headers: Record<string, string> = act, key?: string): Promise<Answer> => call(batchesPost, '/api/v1/batches', { headers, ...(key ? { key } : {}), json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'replace', postId, ...over } });

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

test('a dropped post is given a new topic: a job for that post, the same ask while it runs is the same job, and it is followed with the other jobs', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    engine.batches.push(batch(brand, [post('w01-d1', 'dropped', day(3)), post('w01-d2', 'kept', day(4))]));
    const made = await replace('w01-d1');
    assert.equal(made.status, 202, JSON.stringify(made.body));
    const job = made.body['job'] as { kind: string; state: string; batchId: string; postId: string };
    assert.deepEqual([job.kind, job.state, job.batchId, job.postId, made.body['created']], ['replace', 'queued', 'week-01.json', 'w01-d1', true]);
    assert.deepEqual([engine.seen.at(-1)?.method, engine.seen.at(-1)?.url, engine.seen.at(-1)?.actor], ['POST', `/review/copy/${brand}/week-01.json/w01-d1/replace`, 'brandbasket:user_42']);
    const again = await replace('w01-d1');
    assert.equal(again.status, 200);
    assert.equal(again.body['created'], false, 'the same ask while one runs is the same job');
    assert.equal((again.body['job'] as { id: string }).id, (job as unknown as { id: string }).id);
    const jobs = (await call(jobsGet, '/api/v1/site-jobs?externalId=shop-1')).body['jobs'] as Array<{ kind: string; postId?: string }>;
    assert.deepEqual([jobs[0]?.kind, jobs[0]?.postId], ['replace', 'w01-d1']);
  });
});

test('a new topic is refused plainly: not dropped, no such post, a week that was drawn, a day that has passed, a brand put away, no person named', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    engine.batches.push(batch(brand, [post('w01-d1', 'kept', day(3)), post('w01-d2', 'dropped', day(0)), post('w01-d3', 'dropped', day(5), { replaces: undefined })]));
    expectError(await replace('w01-d1'), 409, 'CONFLICT', 'a post that is not dropped');
    expectError(await replace('nope'), 404, 'NOT_FOUND', 'no such post');
    expectError(await replace('w01-d2'), 409, 'DAY_PASSED', 'its day has passed');
    expectError(await replace('w01-d3', {}, {}), 400, 'ACTOR_REQUIRED', 'no person named');
    expectError(await replace('w01-d3', { batchId: 'week-09.json' }), 404, 'NOT_FOUND', 'no such batch');
    expectError(await replace('w01-d3', { postId: undefined }), 400, 'INVALID_REQUEST', 'no post named');
    expectError(await replace('w01-d3', {}, act, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    (engine.batches[0] as FakeBatch).drawnAt = '2026-11-12T00:00:00Z';
    expectError(await replace('w01-d3'), 409, 'BATCH_LOCKED', 'a week that was drawn');
    delete (engine.batches[0] as { drawnAt?: string }).drawnAt;
    const away = await call(archivePost, '/api/v1/workspaces/archive', { json: { externalId: 'shop-1', archived: true } });
    assert.equal(away.status, 200);
    expectError(await replace('w01-d3'), 409, 'WORKSPACE_ARCHIVED', 'put away');
  });
});

test('a week may have three new topics; the fourth is refused with the day she can ask again', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    engine.batches.push(batch(brand, [1, 2, 3, 4].map((n) => post(`w01-d${n}`, 'dropped', day(2 + n)))));
    for (const n of [1, 2, 3]) assert.equal((await replace(`w01-d${n}`)).status, 202);
    const full = await replace('w01-d4');
    expectError(full, 429, 'REPLACE_LIMIT_REACHED', 'the week has its three');
    assert.match(String(full.body['restart']), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(String(full.body['error']), /3 new topics/);
  });
});

test('the written posts show which post replaced which and how many new topics a week has left', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    const monday = '2026-12-07';
    engine.batches.push(batch(brand, [post('w01-d1', 'dropped', '2026-12-08'), post('w01-r1', 'pending', '2026-12-08', { replaces: 'w01-d1' })], {
      weeks: [{ from: monday, to: '2026-12-13', state: 'waiting', postIds: ['w01-d1', 'w01-r1'] }],
      ...({ replacedBy: { 'w01-d1': 'w01-r1' }, replacementsLeft: { [monday]: 2 } } as Record<string, unknown>),
    }));
    const read = await call(batchesGet, '/api/v1/batches?externalId=shop-1');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const one = (read.body['batches'] as Array<{ posts: Array<Record<string, unknown>>; weeks: Array<Record<string, unknown>> }>)[0];
    assert.equal(one?.posts[0]?.['replacedBy'], 'w01-r1');
    assert.equal(one?.posts[1]?.['replaces'], 'w01-d1');
    assert.equal(one?.weeks[0]?.['replacementsLeft'], 2);
  });
});
