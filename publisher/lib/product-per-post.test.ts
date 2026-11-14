import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as batchesGet, POST as batchesPost } from '../api/_v1/batches.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, fakeEngine, withProducts, type FakeBatch, type FakeEngine } from '../dev/product-test-kit.ts';

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

const act = { 'x-social-actor': 'user_42' };
const monday = '2026-12-07';
const post = (id: string, state: string, day: string, extra: Record<string, unknown> = {}) => ({ postId: id, headline: `H ${id}`, caption: 'W', captions: { instagram: { text: 'ig' } }, state, date: day, ...extra });
const draw = (extra: Record<string, unknown> = {}) => call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'draw', ...extra } });

async function setup(engine: FakeEngine, state: 'waiting' | 'partly_drawn'): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
  const brand = String((made.body['workspace'] as { id: string }).id);
  const drawn = state === 'partly_drawn';
  const posts: FakeBatch['posts'] = [
    post('p0', 'kept', '2026-12-08', drawn ? { drawn: true, locked: true } : { drawn: false, locked: false }),
    post('p1', 'pending', '2026-12-09', { drawn: false, locked: false }),
    post('p2', 'dropped', '2026-12-10', { drawn: false, locked: false }),
  ];
  engine.batches.push({ brand, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts, weeks: [{ from: monday, to: '2026-12-13', state, postIds: ['p0', 'p1', 'p2'], ...(drawn ? { openPostIds: ['p1', 'p2'] } : {}) }] });
  return brand;
}

test('a week drawn by the post reads partly drawn with the posts still open, and each post says whether it was drawn and whether it is final', async () => {
  await withEngine(async (engine) => {
    await setup(engine, 'partly_drawn');
    const read = await call(batchesGet, '/api/v1/batches?externalId=shop-1');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const one = (read.body['batches'] as Array<{ weeks: Array<Record<string, unknown>>; posts: Array<Record<string, unknown>> }>)[0];
    assert.deepEqual([one?.weeks[0]?.['state'], one?.weeks[0]?.['openPostIds']], ['partly_drawn', ['p1', 'p2']]);
    assert.deepEqual(one?.posts.map((p) => [p['id'], p['drawn'], p['locked']]), [['p0', true, true], ['p1', false, false], ['p2', false, false]]);
  });
});

test('asking for pictures again in a partly drawn week is a new round for that week; a week not drawn yet is drawn as before', async () => {
  await withEngine(async (engine) => {
    await setup(engine, 'partly_drawn');
    const round = await draw();
    assert.equal(round.status, 202, JSON.stringify(round.body));
    assert.equal(engine.seen.at(-1)?.url.endsWith('/draw'), true);
    assert.equal(engine.seen.at(-1)?.body?.['week'], monday, 'the week with posts still open is the one asked for');
    engine.jobs[0]!.state = 'succeeded';
    const second = await draw();
    assert.equal(second.status, 202, 'another round after the first one finished');
    const same = await draw();
    assert.equal(same.status, 200, 'a double tap while a round is running is the same job');
    assert.equal(same.body['created'], false);
  });
  await withEngine(async (engine) => {
    await setup(engine, 'waiting');
    const first = await draw();
    assert.equal(first.status, 202);
    assert.equal(engine.seen.at(-1)?.body?.['week'], monday);
  });
});
