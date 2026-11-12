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
  assert.deepEqual(by('w01-d1')?.networks, [{ network: 'instagram', status: 'pending', pictureState: 'ready' }, { network: 'linkedin', status: 'pending', pictureState: 'ready' }], 'the newest picture of a network decides its status');
  assert.deepEqual(by('w01-d1')?.missing, ['facebook', 'google']);
  assert.deepEqual(by('w01-d2')?.missing, [], 'a topic put away unanswered offers nothing');
  assert.deepEqual(by('w02-d1')?.networks, [{ network: 'instagram', status: 'written', pictureState: 'waiting' }]);
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

test('each channel of a topic says what its picture is doing: ready, approved, needs a connection, being drawn, no pictures left, not drawn, or waiting for a day', () => {
  const week = (from: string, state: 'waiting' | 'drawing' | 'drawn', postIds: string[]) => ({ from, to: from, state, postIds });
  const written = (id: string, extra: Record<string, unknown> = {}) => ({ id, headline: `H ${id}`, caption: 'c', captions: { instagram: { text: 'i' }, facebook: { text: 'f' }, linkedin: { text: 'l' } }, state: 'kept', ...extra });
  const batchV = batch({
    id: 'week-05.json',
    weeks: [week('2026-11-16', 'waiting', ['a']), week('2026-11-23', 'waiting', ['b']), week('2026-11-30', 'drawing', ['c'])],
    posts: [written('a'), written('b'), written('c'), written('d', { notDrawn: { code: 'HEADLINE_TOO_WEAK', message: 'This headline is too weak to draw. Change it or drop it.' } })],
  });
  const topics = topicsOf([], [batchV], ['instagram', 'facebook'], { limits: [{ network: 'instagram', left: 3 }, { network: 'facebook', left: 0 }] });
  const state = (post: string, network: string) => topics.find((t) => t.postId === post)?.networks.find((n) => n.network === network);
  assert.equal(state('a', 'linkedin')?.pictureState, 'needs_connection', 'LinkedIn is not connected');
  assert.equal(state('a', 'instagram')?.pictureState, 'waiting');
  assert.equal(state('a', 'instagram')?.drawsOn, undefined, 'the first week is her button, not a day');
  assert.equal(state('a', 'facebook')?.pictureState, 'limit_reached', 'no Facebook pictures left this week');
  assert.deepEqual([state('b', 'instagram')?.pictureState, state('b', 'instagram')?.drawsOn], ['waiting', '2026-11-19'], 'week 2 is drawn on the Thursday before it');
  assert.equal(state('c', 'instagram')?.pictureState, 'drawing');
  assert.deepEqual(state('d', 'instagram')?.notDrawn, { code: 'HEADLINE_TOO_WEAK', message: 'This headline is too weak to draw. Change it or drop it.' });
  assert.equal(state('d', 'instagram')?.pictureState, 'not_drawn');
  // A picture replaces the state of its channel.
  const drawn = topicsOf([poster({ postId: 'a', batchId: 'week-05.json', network: 'instagram', status: 'approved' })], [batchV], ['instagram', 'facebook']);
  const ig = drawn.find((t) => t.postId === 'a')?.networks.find((n) => n.network === 'instagram');
  assert.deepEqual([ig?.status, ig?.pictureState, ig?.drawsOn], ['approved', 'approved', undefined]);
  // With no limits read, nothing is called limit_reached.
  assert.equal(topicsOf([], [batchV], ['instagram', 'facebook']).find((t) => t.postId === 'a')?.networks.find((n) => n.network === 'facebook')?.pictureState, 'waiting');
});
