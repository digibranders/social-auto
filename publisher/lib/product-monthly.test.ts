import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as batchesGet } from '../api/_v1/batches.ts';
import { POST as siteJobsPost } from '../api/_v1/site-jobs.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, fakeEngine, withProducts, type FakeEngine } from '../dev/product-test-kit.ts';
import { nextMonday } from './plan-days.ts';
import { eventsForProgress } from './product-watch.ts';
import type { ExpiredView } from './engine-client.ts';

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

const workspace = async (externalId: string): Promise<string> => {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId, name: externalId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return String((made.body['workspace'] as { id: string }).id);
};

const start = (json: Record<string, unknown> = {}) => call(siteJobsPost, '/api/v1/site-jobs', { headers: { 'x-social-actor': 'user_42' }, json: { externalId: 'shop-1', site: 'acme.example.com', networks: ['instagram'], ...json } });

test('the next Monday is always ahead of today in India time, tomorrow at the earliest', () => {
  assert.equal(nextMonday(Date.parse('2026-11-12T06:30:00Z')), '2026-11-16', 'a Thursday');
  assert.equal(nextMonday(Date.parse('2026-11-16T04:00:00Z')), '2026-11-23', 'a Monday: the one after');
  assert.equal(nextMonday(Date.parse('2026-11-15T10:00:00Z')), '2026-11-16', 'a Sunday');
  assert.equal(nextMonday(Date.parse('2026-11-15T19:00:00Z')), '2026-11-23', 'Sunday 19:00 UTC is already Monday in India');
  assert.equal(nextMonday(Date.parse('2026-12-30T10:00:00Z')), '2027-01-04', 'over the year end');
});

test('a monthly plan is asked for by default, a product may ask for less, and the ceilings and bad values are refused', async () => {
  await withEngine(async (engine) => {
    await workspace('shop-1');
    const sent = () => engine.seen.filter((s) => s.method === 'POST' && s.url === '/review/jobs').at(-1)?.body as Record<string, unknown>;
    assert.equal((await start()).status, 202);
    assert.deepEqual([sent()['weeks'], sent()['postsPerWeek'], sent()['startDate']], [4, 5, nextMonday(Date.now())]);
    engine.jobs.length = 0;
    assert.equal((await start({ weeks: 2, postsPerWeek: 3, startDate: '2099-01-05' })).status, 202);
    assert.deepEqual([sent()['weeks'], sent()['postsPerWeek'], sent()['startDate']], [2, 3, '2099-01-05']);
    for (const bad of [{ weeks: 5 }, { weeks: 0 }, { weeks: 1.5 }, { weeks: '4' }, { postsPerWeek: 6 }, { postsPerWeek: 0 }, { startDate: 'soon' }, { startDate: 20261116 }]) {
      const refused = await start(bad);
      assert.equal(refused.status, 400, JSON.stringify(bad));
      assert.equal(refused.body['code'], 'INVALID_REQUEST');
    }
  });
});

test('the written posts answer says where the plan ends and when the next month may be asked for', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    const read = async (): Promise<{ startsOn: string | null; endsOn: string | null; canStartNext: boolean; nextStartDate: string }> => {
      const answer = await call(batchesGet, '/api/v1/batches?externalId=shop-1');
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body['plan'] as never;
    };
    const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    assert.deepEqual(await read(), { startsOn: null, endsOn: null, canStartNext: true, nextStartDate: nextMonday(Date.now()) }, 'no plan: she may start one');
    engine.plan = { startsOn: day(-5), endsOn: day(25) };
    const running = await read();
    assert.equal(running.canStartNext, false, 'the plan has 25 days to go');
    assert.equal(running.endsOn, day(25));
    assert.ok(running.nextStartDate > day(25) && Date.parse(`${running.nextStartDate}T00:00:00Z`) - Date.parse(`${day(25)}T00:00:00Z`) <= 7 * 86_400_000, 'the Monday after the last post');
    assert.equal(new Date(`${running.nextStartDate}T00:00:00Z`).getUTCDay(), 1);
    engine.plan = { startsOn: day(-20), endsOn: day(9) };
    assert.equal((await read()).canStartNext, true, 'within 10 days of the end');
    engine.plan = { startsOn: day(-40), endsOn: day(-12) };
    const ended = await read();
    assert.deepEqual([ended.canStartNext, ended.nextStartDate], [true, nextMonday(Date.now())], 'a plan that already ended: the next Monday');
    engine.jobs.push({ id: 'job-w00001-0123abcd', key: `copy:${brand}`, kind: 'copy', brand, site: 'https://a.example', by: 'u', networks: [], state: 'running', createdAt: new Date().toISOString() });
    assert.equal((await read()).canStartNext, false, 'while the next batch is being written');
  });
});

const NOW = Date.parse('2026-11-19T05:00:00Z');
const owner = { product: 'brandbasket', externalId: 'shop-1' };
const none = { announced: [] as string[] };

test('a week being drawn, drawn or given up is announced once each, with its batch and week', () => {
  const jobs = [{ id: 'job-a', kind: 'draw', state: 'running', batchId: 'week-01.json', week: '2026-11-23' }];
  const first = eventsForProgress(owner, { jobs, posters: [] }, none, NOW);
  assert.deepEqual(first.items.map((i) => i.event.type), ['week.drawing']);
  assert.deepEqual(first.items[0]?.event.data, { externalId: 'shop-1', batchId: 'week-01.json', week: '2026-11-23', jobId: 'job-a' });
  const again = eventsForProgress(owner, { jobs, posters: [] }, { announced: first.announced }, NOW);
  assert.deepEqual(again.items, [], 'told once');
  const done = eventsForProgress(owner, { jobs: [{ ...jobs[0]!, state: 'done' }], posters: [] }, { announced: first.announced }, NOW);
  assert.deepEqual(done.items.map((i) => i.event.type), ['week.drawn', 'job.finished']);
  const lapsed: ExpiredView[] = [{ at: '2026-11-30T05:00:00.000Z', kind: 'week', batchId: 'week-01.json', week: '2026-11-23' }];
  const gone = eventsForProgress(owner, { jobs: [], posters: [], expired: lapsed }, none, NOW);
  assert.deepEqual(gone.items.map((i) => [i.event.type, i.event.data['week'], i.event.data['batchId']]), [['week.lapsed', '2026-11-23', 'week-01.json']]);
  assert.equal(eventsForProgress(owner, { jobs: [], posters: [], expired: lapsed }, { announced: gone.announced }, NOW).items.length, 0);
  // A draw with no week (a batch of one piece, a redraw) is not a week event.
  assert.deepEqual(eventsForProgress(owner, { jobs: [{ id: 'job-b', kind: 'draw', state: 'running', batchId: 'week-01.json' }], posters: [] }, none, NOW).items, []);
});
