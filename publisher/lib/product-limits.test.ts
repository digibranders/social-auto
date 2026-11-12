import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as limitsGet } from '../api/_v1/limits.ts';
import { POST as batchesPost } from '../api/_v1/batches.ts';
import { POST as postersPost } from '../api/_v1/posters.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, fakeEngine, OTHER_KEY, withProducts, type FakeEngine, type FakePoster } from '../dev/product-test-kit.ts';

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

async function workspace(externalId: string): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId, name: externalId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return String((made.body['workspace'] as { id: string }).id);
}

const act = { 'x-social-actor': 'user_42' };
const SENTENCE = 'You have used your 5 Instagram pictures for this week. You can draw more from Monday 16 November.';

test('GET /api/v1/limits answers the week and what is left for each channel, for her own workspace only', async () => {
  await withEngine(async (engine) => {
    await workspace('shop-1');
    engine.weekly.used = { instagram: 5, facebook: 2, linkedin: 0, google: 0 };
    const answer = await call(limitsGet, '/api/v1/limits?externalId=shop-1');
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, {
      week: { from: '2026-11-09', to: '2026-11-15', restart: '2026-11-16' },
      limit: 5,
      channels: [
        { network: 'instagram', limit: 5, used: 5, left: 0 },
        { network: 'facebook', limit: 5, used: 2, left: 3 },
        { network: 'linkedin', limit: 5, used: 0, left: 5 },
        { network: 'google', limit: 5, used: 0, left: 5 },
      ],
    });
    assert.doesNotMatch(JSON.stringify(answer.body), /brand|bb-/);
    assert.equal((await call(limitsGet, '/api/v1/limits?externalId=shop-1', { key: OTHER_KEY })).status, 404);
    assert.equal((await call(limitsGet, '/api/v1/limits?externalId=nobody')).status, 404);
    assert.equal((await call(limitsGet, '/api/v1/limits')).status, 400);
  });
});

test('a draw, a redraw or an added network that the engine refuses for a channel with no pictures left answers 429 PICTURE_LIMIT_REACHED with the sentence, the channel and the restart day', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const sha = (n: number): string => n.toString(16).padStart(16, '0');
    const p: FakePoster = { versionId: `${one}.${sha(1)}`, brand: one, postId: 'w01-d1', planFile: 'week-01.json', versionNumber: 1, network: 'instagram', status: 'pending', headline: 'H', caption: 'C', width: 1080, height: 1080, shape: 'square', createdAt: '2026-11-11T08:00:00Z', costUsd: 0.016 };
    engine.posters.push(p);
    engine.batches.push({ brand: one, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts: [{ postId: 'w01-d1', headline: 'H', caption: 'C', state: 'kept', captions: { instagram: { text: 'ig' } } }] });
    engine.refusePictures = { channel: 'instagram', restart: '2026-11-16', error: SENTENCE };
    const expected = { error: SENTENCE, code: 'PICTURE_LIMIT_REACHED', channel: 'instagram', restart: '2026-11-16' };
    const redraw = await call(postersPost, '/api/v1/posters', { headers: act, json: { externalId: 'shop-1', action: 'redraw', id: p.versionId } });
    assert.equal(redraw.status, 429);
    assert.deepEqual(redraw.body, expected);
    const draw = await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'draw' } });
    assert.equal(draw.status, 429);
    assert.deepEqual(draw.body, expected);
  });
});

test('the engine\'s own words are shown only when they have the fixed shape of the sentence; anything else is replaced and nothing else of it is passed on', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    engine.batches.push({ brand: one, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts: [{ postId: 'w01-d1', headline: 'H', caption: 'C', state: 'kept', captions: { instagram: { text: 'ig' } } }] });
    engine.refusePictures = { channel: 'instagram', restart: '2026-11-16', error: 'internal: /home/social/ledger/paid-calls.jsonl is full' };
    const draw = await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'draw' } });
    assert.equal(draw.status, 429);
    assert.equal(draw.body['code'], 'PICTURE_LIMIT_REACHED');
    assert.match(String(draw.body['error']), /^You have used the pictures you can draw for this channel this week/);
    assert.doesNotMatch(JSON.stringify(draw.body), /home|ledger|jsonl/);
  });
});
