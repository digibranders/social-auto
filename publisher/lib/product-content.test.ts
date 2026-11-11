import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as batchesGet, POST as batchesPost } from '../api/_v1/batches.ts';
import { GET as factsGet, POST as factsPost } from '../api/_v1/facts.ts';
import { GET as jobsGet } from '../api/_v1/site-jobs.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { addLinkedInMember } from './channels.ts';
import { parseKey } from './crypto.ts';
import { loadChannels, saveChannels } from './store.ts';
import { call, CHANNEL_KEY, fakeEngine, OTHER_KEY, withProducts, type Answer, type FakeBatch, type FakeEngine, type FakeFact, type FakeJob } from '../dev/product-test-kit.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error'], `${label}: only code and error`);
  assert.doesNotMatch(JSON.stringify(answer.body), /\/home|ENOENT|held back from the automatic/, `${label}: nothing of the engine's own words`);
}

const fact = (n: number, over: Partial<FakeFact> = {}): FakeFact => ({ factId: `${n}`.padStart(12, 'a'), text: `Fact ${n}`, sourceUrl: 'https://acme.example/x', sourceQuote: `Quote ${n}`, state: 'suggested', held: false, ...over });
const batch = (brand: string, over: Partial<FakeBatch> = {}): FakeBatch => ({ brand, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts: [{ postId: 'w01-d1', headline: 'Answers', caption: 'Words', captions: { instagram: { text: 'Words' } }, contentHash: 'abc', state: 'pending', advice: 'weak headline', decidedBy: 'x' }], ...over });

async function workspace(externalId: string, key?: string): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { ...(key ? { key } : {}), json: { externalId, name: externalId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return String((made.body['workspace'] as { id: string }).id);
}

const act = { 'x-social-actor': 'user_42' };
const decide = (externalId: string, factId: string, action: string, headers: Record<string, string> = act): Promise<Answer> => call(factsPost, '/api/v1/facts', { headers, json: { externalId, factId, action } });
const change = (externalId: string, json: Record<string, unknown>, headers: Record<string, string> = act): Promise<Answer> => call(batchesPost, '/api/v1/batches', { headers, json: { externalId, batchId: 'week-01.json', ...json } });

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

test('facts: the customer sees safe fields only, and confirms, removes and restores as a named person', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    engine.facts[brand] = [fact(1), fact(2, { held: true, proofHold: { reason: 'unclear source' } })];
    const read = await call(factsGet, '/api/v1/facts?externalId=shop-1');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(Object.keys(read.body).sort(), ['builtAt', 'counts', 'facts', 'profile']);
    const facts = read.body['facts'] as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(facts[0] as object).sort(), ['held', 'id', 'sourceQuote', 'sourceUrl', 'state', 'text']);
    assert.doesNotMatch(JSON.stringify(read.body), /secretPath|unclear source|\/home|mode/);
    assert.equal(facts[1]?.['held'], true);

    const confirmed = await decide('shop-1', fact(1).factId, 'confirm');
    assert.equal(confirmed.status, 200);
    assert.equal((confirmed.body['counts'] as Record<string, number>)['confirmed'], 1);
    const seen = engine.seen.at(-1);
    assert.deepEqual([seen?.method, seen?.url, seen?.brand, seen?.actor], ['POST', `/review/brands/${brand}/facts/${fact(1).factId}/confirm`, brand, 'brandbasket:user_42']);
    assert.equal((await decide('shop-1', fact(1).factId, 'remove')).status, 200);
    assert.equal((await decide('shop-1', fact(1).factId, 'restore')).status, 200);
    assert.equal(engine.facts[brand]?.[0]?.state, 'suggested');
  });
});

test('facts: refusals use the product API\'s own codes and words', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    expectError(await call(factsGet, '/api/v1/facts?externalId=shop-1'), 404, 'NOT_FOUND', 'no facts yet');
    engine.facts[brand] = [fact(1), fact(2, { held: true, proofHold: { reason: 'unclear source' } })];
    expectError(await decide('shop-1', fact(2).factId, 'confirm'), 409, 'FACT_HELD', 'held');
    expectError(await decide('shop-1', fact(9).factId, 'confirm'), 404, 'NOT_FOUND', 'no such fact');
    expectError(await decide('shop-1', '../x', 'confirm'), 404, 'NOT_FOUND', 'not a fact id');
    expectError(await decide('shop-1', fact(1).factId, 'delete'), 400, 'INVALID_REQUEST', 'bad action');
    expectError(await decide('shop-1', fact(1).factId, 'confirm', {}), 400, 'ACTOR_REQUIRED', 'a decision needs a person');
    expectError(await decide('shop-1', fact(1).factId, 'confirm', { 'x-social-actor': 'bad actor!' }), 400, 'INVALID_ACTOR', 'bad person');
    expectError(await call(factsGet, '/api/v1/facts?externalId=nobody'), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
    expectError(await call(factsGet, '/api/v1/facts?externalId=shop-1', { key: OTHER_KEY }), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    expectError(await call(factsGet, '/api/v1/facts?externalId=shop-1', { key: null }), 401, 'UNAUTHORIZED', 'no key');
  });
});

test('facts: one customer never sees or changes another\'s', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const two = await workspace('shop-2');
    engine.facts[one] = [fact(1)];
    engine.facts[two] = [fact(5, { text: 'Only shop two' })];
    const read = await call(factsGet, '/api/v1/facts?externalId=shop-1');
    assert.doesNotMatch(JSON.stringify(read.body), /Only shop two/);
    expectError(await decide('shop-1', fact(5).factId, 'remove'), 404, 'NOT_FOUND', 'the other customer\'s fact id');
    assert.equal(engine.facts[two]?.[0]?.state, 'suggested');
  });
});

test('batches: the written posts come back without the engine\'s extras, and keep, drop, edit and close are recorded under the person', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    const other = await workspace('shop-2');
    engine.batches.push(batch(brand), batch(other, { posts: [{ postId: 'w01-d1', headline: 'Shop two secret', caption: 'x', state: 'pending' }] }));
    const read = await call(batchesGet, '/api/v1/batches?externalId=shop-1');
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const batches = read.body['batches'] as Array<Record<string, unknown>>;
    assert.equal(batches.length, 1);
    assert.deepEqual(Object.keys(batches[0] as object).sort(), ['createdAt', 'id', 'networks', 'posts']);
    assert.equal(batches[0]?.['id'], 'week-01.json');
    const post = (batches[0]?.['posts'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(post).sort(), ['advice', 'caption', 'captions', 'headline', 'id', 'state']);
    assert.doesNotMatch(JSON.stringify(read.body), /costUsd|decidedBy|contentHash|Shop two secret/);
    assert.ok(read.body['networkRules']);

    const kept = await change('shop-1', { action: 'keep', postId: 'w01-d1' });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal((((kept.body['batch'] as Record<string, unknown>)['posts']) as Array<Record<string, unknown>>)[0]?.['state'], 'kept');
    assert.deepEqual([engine.seen.at(-1)?.url, engine.seen.at(-1)?.actor], [`/review/copy/${brand}/week-01.json/w01-d1/keep`, 'brandbasket:user_42']);
    assert.equal((await change('shop-1', { action: 'drop', postId: 'w01-d1' })).status, 200);
    const edited = await change('shop-1', { action: 'edit', postId: 'w01-d1', headline: 'New headline', caption: 'New words', brandName: 'Acme', domain: '' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(engine.seen.at(-1)?.body, { headline: 'New headline', caption: 'New words', brandName: 'Acme', domain: '' });
    assert.equal(engine.seen.at(-1)?.method, 'PUT');
    assert.equal((await change('shop-1', { action: 'close' })).status, 200);
    assert.equal(((await call(batchesGet, '/api/v1/batches?externalId=shop-1')).body['batches'] as unknown[]).length, 0, 'a closed batch is gone');
  });
});

test('batches: refusals and bad requests', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    const other = await workspace('shop-2');
    engine.batches.push(batch(brand), batch(other, { planFile: 'week-02.json' }), batch(brand, { planFile: 'week-03.json', drawnAt: '2026-11-11T09:00:00.000Z' }));
    expectError(await change('shop-1', { action: 'edit', postId: 'w01-d1', caption: 'a BADFACT here' }), 422, 'WORDS_NOT_ACCEPTED', 'words not agreeing with the facts');
    expectError(await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-03.json', action: 'keep', postId: 'w01-d1' } }), 409, 'BATCH_LOCKED', 'drawn batch');
    expectError(await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-02.json', action: 'close' } }), 404, 'NOT_FOUND', 'the other customer\'s batch');
    expectError(await change('shop-1', { action: 'keep', postId: 'nope' }), 404, 'NOT_FOUND', 'no such post');
    expectError(await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: '../x', action: 'close' } }), 404, 'NOT_FOUND', 'path trick in the batch id');
    expectError(await change('shop-1', { action: 'keep', postId: '../../x' }), 404, 'NOT_FOUND', 'path trick in the post id');
    expectError(await change('shop-1', { action: 'keep' }), 400, 'INVALID_REQUEST', 'post id missing');
    expectError(await change('shop-1', { action: 'edit', postId: 'w01-d1' }), 400, 'NOTHING_TO_CHANGE', 'nothing to change');
    expectError(await change('shop-1', { action: 'edit', postId: 'w01-d1', headline: 'x'.repeat(301) }), 400, 'INVALID_REQUEST', 'headline too long');
    expectError(await change('shop-1', { action: 'edit', postId: 'w01-d1', caption: 5 }), 400, 'INVALID_REQUEST', 'caption not text');
    expectError(await change('shop-1', { action: 'explode', postId: 'w01-d1' }), 400, 'INVALID_REQUEST', 'unknown action');
    expectError(await change('shop-1', { action: 'keep', postId: 'w01-d1' }, {}), 400, 'ACTOR_REQUIRED', 'a decision needs a person');
    const before = engine.seen.length;
    expectError(await call(batchesPost, '/api/v1/batches', { headers: act, key: OTHER_KEY, json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'keep', postId: 'w01-d1' } }), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    assert.equal(engine.seen.length, before, 'nothing reached the engine');
  });
});

test('add network: a job that writes the words of one more connected network for the batch, from the same topics', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    const { file, etag } = await loadChannels();
    await saveChannels(addLinkedInMember(file, brand, { urn: 'urn:li:person:abcdefabc', name: 'T' }, 'token', 5_000_000, parseKey(CHANNEL_KEY), Date.now() - 3_600_000), etag);
    engine.batches.push(batch(brand));
    const add = (json: Record<string, unknown>, headers: Record<string, string> = act): Promise<Answer> => call(batchesPost, '/api/v1/batches', { headers, json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'add-network', ...json } });

    const made = await add({ network: 'linkedin' });
    assert.equal(made.status, 202, JSON.stringify(made.body));
    const job = made.body['job'] as Record<string, unknown>;
    assert.deepEqual([job['kind'], job['state'], job['batchId'], made.body['created']], ['network', 'queued', 'week-01.json', true]);
    assert.deepEqual([engine.seen.at(-1)?.url, engine.seen.at(-1)?.actor, engine.seen.at(-1)?.body], [`/review/copy/${brand}/week-01.json/networks`, 'brandbasket:user_42', { network: 'linkedin' }]);
    const again = await add({ network: 'linkedin' });
    assert.deepEqual([again.status, again.body['created']], [200, false]);

    // The finished job says what happened to each topic, with fixed codes only.
    const fake = engine.jobs.find((j) => j.kind === 'network') as FakeJob;
    fake.state = 'succeeded';
    fake.result = { network: 'linkedin', topics: [{ postId: 'w01-d1', outcome: 'written', versionIds: [`${brand}.${'1'.padStart(16, '0')}`, 'other.0000000000000001'] }, { postId: 'w01-d2', outcome: 'written', fallback: true, reason: 'the caption says /home/social/x', drawJobId: 'job-abc123-0123abcd' }] };
    const done = await call(jobsGet, `/api/v1/site-jobs?externalId=shop-1&jobId=${String(job['id'])}`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual((done.body['job'] as Record<string, unknown>)['result'], { network: 'linkedin', topics: [{ postId: 'w01-d1', outcome: 'written', posterIds: [`${brand}.${'1'.padStart(16, '0')}`] }, { postId: 'w01-d2', outcome: 'written', fallback: true, drawJobId: 'job-abc123-0123abcd' }] });
    assert.doesNotMatch(JSON.stringify(done.body), /\/home|other\./);
    fake.state = 'failed';
    fake.error = { code: 'WRITE_FAILED', message: 'every topic /home/x' };
    delete fake.result;
    assert.equal(((await call(jobsGet, `/api/v1/site-jobs?externalId=shop-1&jobId=${String(job['id'])}`)).body['job'] as Record<string, unknown>)['failure'], 'WRITE_FAILED');

    expectError(await add({ network: 'myspace' }), 400, 'INVALID_NETWORKS', 'unknown network');
    expectError(await add({}), 400, 'INVALID_NETWORKS', 'no network');
    expectError(await add({ network: 'facebook' }), 400, 'CHANNEL_NOT_CONNECTED', 'no account on that platform');
    expectError(await add({ network: 'linkedin' }, {}), 400, 'ACTOR_REQUIRED', 'a person is needed');
    expectError(await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'nope.json', action: 'add-network', network: 'linkedin' } }), 404, 'NOT_FOUND', 'no such batch');
    engine.batches.push(batch(brand, { planFile: 'week-09.json', closedAt: 'x' }));
    expectError(await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-09.json', action: 'add-network', network: 'linkedin' } }), 409, 'BATCH_LOCKED', 'a closed batch');
  });
});
