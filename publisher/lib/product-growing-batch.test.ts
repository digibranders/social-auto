import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as batchesGet } from '../api/_v1/batches.ts';
import { GET as jobsGet } from '../api/_v1/site-jobs.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, fakeEngine, withProducts, type FakeJob } from '../dev/product-test-kit.ts';

const writeJob = (brand: string, over: Partial<FakeJob>): FakeJob => ({ id: 'job-mxyz12ab-0a1b2c3d', key: 'k', kind: 'copy', brand, site: 'https://shop.example.com', by: 'user_42', networks: ['instagram'], state: 'running', createdAt: '2026-11-14T10:00:00.000Z', ...over });

test('a batch written week by week: the job says how many weeks are saved, the batch exists from week 1, and a later failure keeps the weeks and says so', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
      const brand = String((made.body['workspace'] as { id: string }).id);
      const read = async (): Promise<Record<string, unknown>> => (await call(jobsGet, '/api/v1/site-jobs?externalId=shop-1&jobId=job-mxyz12ab-0a1b2c3d')).body['job'] as Record<string, unknown>;

      engine.jobs.push(writeJob(brand, { step: 2, planFileMade: 'week-01.json', weeksDone: 0, weeksTotal: 4 }));
      let job = await read();
      assert.deepEqual([job['weeksDone'], job['weeksTotal'], job['state'], job['partial'], job['batchId']], [0, 4, 'running', undefined, undefined], 'the file name is announced before anything is saved, so no batch yet');

      Object.assign(engine.jobs[0] as FakeJob, { weeksDone: 1 });
      job = await read();
      assert.deepEqual([job['weeksDone'], job['batchId'], job['partial']], [1, 'week-01.json', undefined]);

      Object.assign(engine.jobs[0] as FakeJob, { weeksDone: 2, state: 'failed', error: { code: 'WRITE_FAILED', message: 'x' }, finishedAt: '2026-11-14T10:09:00.000Z' });
      job = await read();
      assert.deepEqual([job['state'], job['failure'], job['partial'], job['weeksDone'], job['weeksTotal'], job['batchId']], ['failed', 'WRITE_FAILED', true, 2, 4, 'week-01.json']);

      Object.assign(engine.jobs[0] as FakeJob, { weeksDone: 0, state: 'failed' });
      assert.equal((await read())['partial'], undefined, 'nothing was saved, so nothing is partial');

      Object.assign(engine.jobs[0] as FakeJob, { weeksDone: 4, state: 'succeeded' });
      job = await read();
      assert.deepEqual([job['state'], job['weeksDone'], job['partial']], ['done', 4, undefined]);
    } finally {
      await engine.close();
    }
  });
});

test('the batch lists `writing` only while it is growing', async () => {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
      const brand = String((made.body['workspace'] as { id: string }).id);
      const posts = [{ postId: 'w01-d1', headline: 'H', caption: 'C', state: 'pending', date: '2026-11-16' }];
      engine.batches.push({ brand, planFile: 'week-01.json', createdAt: '2026-11-14T10:05:00.000Z', writing: { weeksDone: 1, weeksTotal: 4 }, posts });
      const growing = (await call(batchesGet, '/api/v1/batches?externalId=shop-1')).body['batches'] as Array<Record<string, unknown>>;
      assert.deepEqual(growing[0]?.['writing'], { weeksDone: 1, weeksTotal: 4 });
      delete engine.batches[0]?.writing;
      const done = (await call(batchesGet, '/api/v1/batches?externalId=shop-1')).body['batches'] as Array<Record<string, unknown>>;
      assert.equal(done[0]?.['writing'], undefined);
    } finally {
      await engine.close();
    }
  });
});
