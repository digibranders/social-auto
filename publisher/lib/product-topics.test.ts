import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as topicsGet } from '../api/_v1/topics.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, CHANNEL_KEY, fakeEngine, OTHER_KEY, withProducts, type FakeBatch, type FakeEngine, type FakePoster } from '../dev/product-test-kit.ts';
import { addLinkedInMember } from './channels.ts';
import { parseKey } from './crypto.ts';
import { loadChannels, saveChannels } from './store.ts';
import { topicsOf } from './topics.ts';
import type { BatchView, PosterView } from './engine-client.ts';

const poster = (over: Partial<PosterView> = {}): PosterView => ({ id: 'b.0000000000000001', batchId: 'week-01.json', postId: 'w01-d1', network: 'instagram', shape: 'square', width: 1, height: 1, headline: 'Fresh laddoos', caption: 'c', versionNumber: 1, status: 'approved', canRedraw: false, redrawsLeft: 0, createdAt: 'x', ...over });
const batch = (over: Partial<BatchView> = {}): BatchView => ({ id: 'week-02.json', createdAt: 'x', networks: ['instagram'], posts: [{ id: 'w02-d1', headline: 'Diwali boxes', caption: 'c', captions: { instagram: { text: 'c' } }, state: 'pending' }], ...over });

test('a topic lists the networks it has and the connected networks it lacks', () => {
  const topics = topicsOf(
    [poster(), poster({ id: 'b.2', network: 'linkedin', status: 'pending' }), poster({ id: 'b.3', network: 'instagram', versionNumber: 2, status: 'pending' }), poster({ id: 'b.4', postId: 'w01-d2', headline: 'Family recipes', status: 'expired' })],
    [batch()],
    ['linkedin', 'instagram', 'facebook', 'google'],
  );
  const by = (id: string) => topics.find((t) => t.postId === id);
  assert.deepEqual(by('w01-d1')?.networks, [{ network: 'instagram', status: 'pending' }, { network: 'linkedin', status: 'pending' }], 'the newest picture of a network decides its status');
  assert.deepEqual(by('w01-d1')?.missing, ['facebook', 'google']);
  assert.deepEqual(by('w01-d2')?.missing, [], 'a topic put away unanswered offers nothing');
  assert.deepEqual(by('w02-d1')?.networks, [{ network: 'instagram', status: 'written' }]);
  assert.deepEqual(by('w02-d1')?.missing, ['linkedin', 'facebook', 'google']);
  assert.deepEqual(topicsOf([], [], ['instagram']), []);
  assert.deepEqual(topicsOf([poster()], [], ['instagram', 'myspace']).map((t) => t.missing), [[]], 'only the four networks are offered');
});

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

test('GET /api/v1/topics answers from the posters, the waiting batches and her connected accounts, for her own workspace only', async () => {
  await withEngine(async (engine) => {
    const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop' } });
    const brand = String((made.body['workspace'] as { id: string }).id);
    const { file, etag } = await loadChannels();
    await saveChannels(addLinkedInMember(file, brand, { urn: 'urn:li:person:abcdefabc', name: 'T' }, 'token', 5_000_000, parseKey(CHANNEL_KEY), Date.now() - 3_600_000), etag);
    const p: FakePoster = { versionId: `${brand}.${'1'.padStart(16, '0')}`, brand, postId: 'w01-d1', planFile: 'week-01.json', versionNumber: 1, network: 'instagram', status: 'approved', headline: 'Fresh laddoos', caption: 'c', width: 1, height: 1, shape: 'square', createdAt: 'x', costUsd: 1 };
    engine.posters.push(p);
    const waiting: FakeBatch = { brand, planFile: 'week-02.json', createdAt: 'x', posts: [{ postId: 'w02-d1', headline: 'Diwali boxes', caption: 'c', state: 'pending', captions: { instagram: { text: 'c' } } }] };
    engine.batches.push(waiting);
    const answer = await call(topicsGet, '/api/v1/topics?externalId=shop-1');
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body['connected'], ['linkedin']);
    const topics = answer.body['topics'] as Array<{ postId: string; networks: unknown[]; missing: string[] }>;
    assert.deepEqual(topics.map((t) => [t.postId, t.missing]), [['w01-d1', ['linkedin']], ['w02-d1', ['linkedin']]]);
    assert.doesNotMatch(JSON.stringify(answer.body), /costUsd|brand"/);
    assert.equal((await call(topicsGet, '/api/v1/topics?externalId=shop-1', { key: OTHER_KEY })).status, 404);
    assert.equal((await call(topicsGet, '/api/v1/topics?externalId=nobody')).status, 404);
  });
});
