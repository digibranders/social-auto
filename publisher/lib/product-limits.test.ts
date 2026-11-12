import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as limitsGet } from '../api/_v1/limits.ts';
import { GET as batchesGet, POST as batchesPost } from '../api/_v1/batches.ts';
import { POST as postersPost } from '../api/_v1/posters.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, CHANNEL_KEY, fakeEngine, OTHER_KEY, withProducts, type FakeEngine, type FakeJob, type FakePoster } from '../dev/product-test-kit.ts';
import { addLinkedInMember } from './channels.ts';
import { forgetConnected } from './connected-sync.ts';
import { parseKey } from './crypto.ts';
import { loadChannels, saveChannels } from './store.ts'; 

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

const sha = (n: number): string => n.toString(16).padStart(16, '0');

test('a batch written for several weeks is drawn one week at a time: the week asked for, else the first not settled; a week asked twice is the same job', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const post = (id: string, date: string) => ({ postId: id, date, headline: `H ${id}`, caption: 'C', state: 'kept', captions: { instagram: { text: 'ig' } } });
    engine.batches.push({
      brand: one, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z',
      weeks: [{ from: '2026-11-16', to: '2026-11-22', state: 'waiting', postIds: ['w1-d1'] }, { from: '2026-11-23', to: '2026-11-29', state: 'waiting', postIds: ['w2-d1'] }],
      posts: [post('w1-d1', '2026-11-16'), post('w2-d1', '2026-11-23')],
    });
    const draw = (json: Record<string, unknown> = {}) => call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'draw', ...json } });
    const batches = await call(batchesGet, '/api/v1/batches?externalId=shop-1');
    const listed = (batches.body['batches'] as Array<{ weeks: unknown[]; posts: Array<{ date: string }> }>)[0];
    assert.deepEqual(listed?.weeks, [{ from: '2026-11-16', to: '2026-11-22', state: 'waiting', postIds: ['w1-d1'] }, { from: '2026-11-23', to: '2026-11-29', state: 'waiting', postIds: ['w2-d1'] }]);
    assert.equal(listed?.posts[0]?.date, '2026-11-16');

    const first = await draw();
    assert.equal(first.status, 202, JSON.stringify(first.body));
    const job = first.body['job'] as { id: string; week: string; batchId: string };
    assert.deepEqual([job.week, job.batchId], ['2026-11-16', 'week-01.json'], 'no week asked for: the first one waiting');
    assert.equal(engine.seen.at(-1)?.body?.['week'], '2026-11-16');
    const again = await draw({ week: '2026-11-16' });
    assert.equal(again.status, 200);
    assert.equal((again.body['job'] as { id: string }).id, job.id);
    const nothing = await draw();
    assert.equal(nothing.status, 200, 'asking again with no week never starts the next week by accident: it is the first week\'s job');
    assert.equal((nothing.body['job'] as { id: string }).id, job.id);
    const next = await draw({ week: '2026-11-23' });
    assert.equal(next.status, 202, 'a later week is drawn only when it is asked for');
    assert.equal((next.body['job'] as { week: string }).week, '2026-11-23');
    const bad = await draw({ week: 'soon' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body['code'], 'INVALID_REQUEST');
    const unknown = await draw({ week: '2026-12-07' });
    assert.equal(unknown.status, 400, 'a week the batch does not have is refused by the poster service');
  });
});

const drawJob = (brand: string, n: number, over: Partial<FakeJob> = {}): FakeJob => ({ id: `job-x${n.toString(36).padStart(5, '0')}-0123abcd`, key: `draw:${brand}:week-0${n}.json`, kind: 'draw', brand, site: 'https://acme.example', by: 'brandbasket:user_42', networks: [], planFile: `week-0${n}.json`, state: 'succeeded', createdAt: new Date().toISOString(), ...over });

test('what the system draws by itself each week is not one of the customer\'s asks: three of her own asks a day stop her, three automatic draws do not', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    engine.batches.push({ brand: one, planFile: 'week-09.json', createdAt: '2026-11-11T07:54:27.999Z', posts: [{ postId: 'w1-d1', headline: 'H', caption: 'C', state: 'kept', captions: { instagram: { text: 'ig' } } }] });
    const ask = () => call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-09.json', action: 'draw' } });
    engine.jobs.push(...[1, 2, 3].map((n) => drawJob(one, n, { auto: true, by: 'system:weekly-draw' })));
    assert.equal((await ask()).status, 202, 'three automatic draws do not count');
    engine.jobs.length = 0;
    engine.batches[0]!.drawnAt = undefined;
    engine.jobs.push(...[1, 2, 3].map((n) => drawJob(one, n)));
    const stopped = await ask();
    assert.equal(stopped.status, 429);
    assert.equal(stopped.body['code'], 'DRAW_LIMIT_REACHED');
  });
});

test('the product API tells the poster service which networks the customer has connected, once, and again only when they change', async () => {
  await withEngine(async (engine) => {
    forgetConnected();
    const one = await workspace('shop-1');
    const { file, etag } = await loadChannels();
    await saveChannels(addLinkedInMember(file, one, { urn: 'urn:li:person:abcdefabc', name: 'T' }, 'token', 5_000_000, parseKey(CHANNEL_KEY), Date.now() - 3_600_000), etag);
    const puts = (): number => engine.seen.filter((r) => r.method === 'PUT' && r.url === '/review/connected').length;
    assert.equal((await call(batchesGet, '/api/v1/batches?externalId=shop-1')).status, 200);
    assert.deepEqual(engine.connected, ['linkedin']);
    assert.equal(puts(), 1);
    await call(batchesGet, '/api/v1/batches?externalId=shop-1');
    assert.equal(puts(), 1, 'nothing changed, so it is not told again');
  });
});
