import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as batchesGet } from '../api/_v1/batches.ts';
import { GET as postersGet } from '../api/_v1/posters.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, fakeEngine, withProducts, type FakeBatch, type FakeEngine, type FakePoster } from '../dev/product-test-kit.ts';

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

const poster = (brand: string, n: number, extra: Partial<FakePoster> = {}): FakePoster => ({ versionId: `${brand}.${n.toString(16).padStart(16, '0')}`, brand, postId: `w01-d${n}`, planFile: 'week-01.json', versionNumber: 1, network: 'instagram', status: 'pending', headline: 'H', caption: 'C', width: 1080, height: 1080, shape: 'square', createdAt: '2026-11-12T08:00:00Z', costUsd: 0.02, ...extra });

test('every picture says the day and time it goes out, so a screen can show "Mon 16 Nov 10:00" after the week is drawn; a plan that does not say leaves them out', async () => {
  await withEngine(async (engine) => {
    const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
    const brand = String((made.body['workspace'] as { id: string }).id);
    engine.posters.push(poster(brand, 1, { date: '2026-11-16', time: '10:00' }), poster(brand, 2, { date: 'next week', time: '25:99' }), poster(brand, 3));
    const read = await call(postersGet, '/api/v1/posters?externalId=shop-1');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const rows = read.body['posters'] as Array<{ postId: string; date?: string; time?: string }>;
    const of = (id: string) => rows.find((r) => r.postId === id);
    assert.deepEqual([of('w01-d1')?.date, of('w01-d1')?.time], ['2026-11-16', '10:00']);
    assert.deepEqual([of('w01-d2')?.date, of('w01-d2')?.time], [undefined, undefined], 'a value that is not a day and a time is left out');
    assert.deepEqual([of('w01-d3')?.date, of('w01-d3')?.time], [undefined, undefined]);
  });
});

test('every written post carries its time next to its day', async () => {
  await withEngine(async (engine) => {
    const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
    const brand = String((made.body['workspace'] as { id: string }).id);
    const posts: FakeBatch['posts'] = [
      { postId: 'a', headline: 'A', caption: 'W', captions: { instagram: { text: 'ig' } }, state: 'pending', date: '2026-11-16', time: '14:30' },
      { postId: 'b', headline: 'B', caption: 'W', captions: { instagram: { text: 'ig' } }, state: 'pending', date: '2026-11-17', time: 'soon' },
    ];
    engine.batches.push({ brand, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts });
    const read = await call(batchesGet, '/api/v1/batches?externalId=shop-1');
    const rows = (read.body['batches'] as Array<{ posts: Array<{ id: string; date?: string; time?: string }> }>)[0]?.posts ?? [];
    assert.deepEqual(rows.map((r) => [r.id, r.date, r.time]), [['a', '2026-11-16', '14:30'], ['b', '2026-11-17', undefined]]);
  });
});
