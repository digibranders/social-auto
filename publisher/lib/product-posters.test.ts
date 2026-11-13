import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as batchesGet, POST as batchesPost } from '../api/_v1/batches.ts';
import { GET as postersGet, POST as postersPost } from '../api/_v1/posters.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { call, fakeEngine, OTHER_KEY, withProducts, type Answer, type FakeBatch, type FakeEngine, type FakeJob, type FakePoster } from '../dev/product-test-kit.ts';

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error'], `${label}: only code and error`);
  assert.doesNotMatch(JSON.stringify(answer.body), /\/home|defect at|newer version/, `${label}: nothing of the engine's own words`);
}

async function workspace(externalId: string): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId, name: externalId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return String((made.body['workspace'] as { id: string }).id);
}

const act = { 'x-social-actor': 'user_42' };
const sha = (n: number): string => n.toString(16).padStart(16, '0');
const poster = (brand: string, n: number, over: Partial<FakePoster> = {}): FakePoster => ({ versionId: `${brand}.${sha(n)}`, brand, postId: 'w01-d1', planFile: 'week-01.json', versionNumber: 1, network: n % 2 ? 'instagram' : 'linkedin', status: 'pending', headline: 'Answers', caption: 'Words', width: 1080, height: 1350, shape: 'tall', createdAt: '2026-11-11T07:54:28.026Z', costUsd: 0.016, ...over });
const batch = (brand: string, kept: boolean, over: Partial<FakeBatch> = {}): FakeBatch => ({ brand, planFile: 'week-01.json', createdAt: '2026-11-11T07:54:27.999Z', posts: [{ postId: 'w01-d1', headline: 'Answers', caption: 'Words', state: kept ? 'kept' : 'pending' }], ...over });
const decide = (json: Record<string, unknown>, headers: Record<string, string> = act, key?: string): Promise<Answer> => call(postersPost, '/api/v1/posters', { headers, ...(key ? { key } : {}), json: { externalId: 'shop-1', ...json } });
const draw = (json: Record<string, unknown> = {}, headers: Record<string, string> = act): Promise<Answer> => call(batchesPost, '/api/v1/batches', { headers, json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'draw', ...json } });

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

test('draw: pictures are asked for once per batch, as the named person, and a second ask returns the same job', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    engine.batches.push(batch(brand, true));
    const first = await draw();
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(first.body['created'], true);
    const job = first.body['job'] as Record<string, unknown>;
    assert.deepEqual(Object.keys(job).sort(), ['batchId', 'createdAt', 'id', 'kind', 'state']);
    assert.deepEqual([job['kind'], job['batchId']], ['draw', 'week-01.json']);
    assert.deepEqual([engine.seen.at(-1)?.url, engine.seen.at(-1)?.actor], [`/review/copy/${brand}/week-01.json/draw`, 'brandbasket:user_42']);
    const again = await draw();
    assert.equal(again.status, 200);
    assert.deepEqual([again.body['created'], (again.body['job'] as Record<string, unknown>)['id']], [false, job['id']]);
    assert.equal(engine.jobs.filter((j) => j.kind === 'draw').length, 1, 'only one draw was bought');
    expectError(await call(batchesPost, '/api/v1/batches', { headers: act, json: { externalId: 'shop-1', batchId: 'week-01.json', action: 'keep', postId: 'w01-d1' } }), 409, 'BATCH_LOCKED', 'choices are final after drawing');
    assert.equal(((await call(batchesGet, '/api/v1/batches?externalId=shop-1')).body['batches'] as unknown[]).length, 0);
  });
});

test('draw: refusals, and the per-customer limits', async () => {
  await withEngine(async (engine) => {
    const brand = await workspace('shop-1');
    engine.batches.push(batch(brand, false), batch(brand, true, { planFile: 'week-02.json' }));
    expectError(await draw(), 422, 'NOTHING_KEPT', 'nothing kept');
    expectError(await draw({}, {}), 400, 'ACTOR_REQUIRED', 'a person is needed');
    engine.batches.push(batch(brand, true, { planFile: 'week-09.json', posts: [{ postId: 'w09-d1', headline: 'x', caption: 'y', state: 'kept', noSite: true }] }));
    expectError(await draw({ batchId: 'week-09.json' }), 503, 'ENGINE_UNAVAILABLE', 'any other refusal to draw is not the customer\'s to fix');
    expectError(await draw({ retry: 'yes' }), 400, 'INVALID_REQUEST', 'retry must be true or false');
    expectError(await draw({ batchId: 'nope.json' }), 404, 'NOT_FOUND', 'no such batch');
    const old = (hours: number, n: number): FakeJob => ({ id: `job-e${n.toString(36).padStart(5, '0')}-0123abcd`, key: 'draw', kind: 'draw', brand, site: 'https://acme.example', by: 'x', networks: [], planFile: `old-${n}.json`, state: 'succeeded', createdAt: new Date(Date.now() - hours * 3600_000).toISOString() });
    engine.jobs.push(old(1, 1), old(2, 2), old(3, 3));
    const before = engine.seen.length;
    expectError(await draw({ batchId: 'week-02.json' }), 429, 'DRAW_LIMIT_REACHED', 'three in a day');
    assert.equal(engine.seen.slice(before).filter((s) => s.method === 'POST').length, 0, 'nothing was bought');
    engine.jobs.length = 0;
    for (let n = 1; n <= 10; n += 1) engine.jobs.push(old(24 * (n + 1), n));
    expectError(await draw({ batchId: 'week-02.json' }), 429, 'DRAW_LIMIT_REACHED', 'ten in a month');
  });
});

test('PRODUCT_LIMITS=off lifts the limits on asking for pictures', async () => {
  const before = process.env['PRODUCT_LIMITS'];
  try {
    await withEngine(async (engine) => {
      const brand = await workspace('shop-1');
      engine.batches.push(batch(brand, true, { planFile: 'week-02.json' }));
      const old = (hours: number, n: number): FakeJob => ({ id: `job-e${n.toString(36).padStart(5, '0')}-0123abcd`, key: 'draw', kind: 'draw', brand, site: 'https://acme.example', by: 'x', networks: [], planFile: `old-${n}.json`, state: 'succeeded', createdAt: new Date(Date.now() - hours * 3_600_000).toISOString() });
      engine.jobs.push(...Array.from({ length: 3 }, (_, i) => old(i + 1, i + 1)));
      delete process.env['PRODUCT_LIMITS'];
      expectError(await draw({ batchId: 'week-02.json' }), 429, 'DRAW_LIMIT_REACHED', 'limits on');
      process.env['PRODUCT_LIMITS'] = 'off';
      assert.equal((await draw({ batchId: 'week-02.json' })).status, 202, 'limits off');
    });
  } finally {
    if (before === undefined) delete process.env['PRODUCT_LIMITS'];
    else process.env['PRODUCT_LIMITS'] = before;
  }
});

test('posters: lists, detail and image carry safe fields only and stay with their own customer', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const two = await workspace('shop-2');
    engine.posters.push(poster(one, 1), poster(one, 2, { status: 'approved' }), poster(two, 3, { headline: 'Shop two secret' }));
    const pending = await call(postersGet, '/api/v1/posters?externalId=shop-1');
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    const list = pending.body['posters'] as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0] as object).sort(), ['batchId', 'canRedraw', 'caption', 'createdAt', 'headline', 'height', 'id', 'network', 'postId', 'redrawsLeft', 'shape', 'status', 'versionNumber', 'width']);
    assert.doesNotMatch(JSON.stringify(pending.body), /costUsd|Shop two secret|"brand"/);
    assert.equal(((await call(postersGet, '/api/v1/posters?externalId=shop-1&status=all')).body['posters'] as unknown[]).length, 2);
    expectError(await call(postersGet, '/api/v1/posters?externalId=shop-1&status=weird'), 400, 'INVALID_REQUEST', 'bad status');

    const detail = await call(postersGet, `/api/v1/posters?externalId=shop-1&id=${poster(one, 1).versionId}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const p = detail.body['poster'] as Record<string, unknown>;
    assert.deepEqual(p['evidence'], [{ text: 'Fact', quote: 'Quote', url: 'https://acme.example/x' }]);
    assert.doesNotMatch(JSON.stringify(detail.body), /imageFile|createdBy|costUsd|context|\/home/);
    assert.equal((p['history'] as unknown[]).length, 2);

    const image = await handlerImage(poster(one, 1).versionId);
    assert.deepEqual([image.status, image.type, image.size], [200, 'image/jpeg', 4]);
    expectError(await call(postersGet, `/api/v1/posters?externalId=shop-1&id=${poster(two, 3).versionId}`), 404, 'NOT_FOUND', 'another customer\'s picture');
    const before = engine.seen.length;
    for (const bad of ['../x', 'nope', `${one}.zz`, `${two}.${sha(3)}`]) expectError(await call(postersGet, `/api/v1/posters?externalId=shop-1&id=${encodeURIComponent(bad)}`), 404, 'NOT_FOUND', bad);
    assert.equal(engine.seen.length, before, 'malformed or foreign ids never reach the engine');
    expectError(await call(postersGet, '/api/v1/posters?externalId=shop-1', { key: OTHER_KEY }), 404, 'WORKSPACE_NOT_FOUND', 'another product');
  });
});

async function handlerImage(id: string): Promise<{ status: number; type: string | null; size: number }> {
  const response = await postersGet(new Request(`https://social.example.test/api/v1/posters?externalId=shop-1&id=${id}&image=1`, { headers: { authorization: `Bearer ${(await import('../dev/product-test-kit.ts')).KEY}` } }));
  return { status: response.status, type: response.headers.get('content-type'), size: (await response.arrayBuffer()).byteLength };
}

test('posters: approve, reject, withdraw and approve-topic are recorded under the person, with the product API\'s own codes', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    engine.posters.push(poster(one, 1), poster(one, 2), poster(one, 3, { postId: 'w01-d2' }), poster(one, 4, { status: 'superseded' }), poster(one, 5, { status: 'blocked' }), poster(one, 6, { postId: 'w01-d3' }));
    const approved = await decide({ action: 'approve', id: poster(one, 1).versionId });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual(approved.body['decision'], { id: poster(one, 1).versionId, status: 'approved', decidedAt: '2026-11-11T09:00:00.000Z' });
    assert.equal(engine.seen.at(-1)?.actor, 'brandbasket:user_42');
    assert.deepEqual((await decide({ action: 'approve', id: poster(one, 1).versionId })).body, approved.body, 'repeating gives the same answer');

    const topic = await decide({ action: 'approve-topic', batchId: 'week-01.json', postId: 'w01-d1' });
    assert.equal(topic.status, 200, JSON.stringify(topic.body));
    assert.deepEqual((topic.body['decisions'] as Array<Record<string, unknown>>).map((d) => d['id']), [poster(one, 2).versionId]);
    expectError(await decide({ action: 'approve-topic', batchId: 'week-01.json', postId: 'w09-d9' }), 404, 'NOT_FOUND', 'nothing waiting for the topic');

    const rejected = await decide({ action: 'reject', id: poster(one, 3).versionId, reason: 'weak_copy', comment: 'too plain' });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal((rejected.body['decision'] as Record<string, unknown>)['status'], 'rejected');
    assert.deepEqual(engine.seen.at(-1)?.body, { reason: 'weak_copy', comment: 'too plain' });

    const withdrawn = await decide({ action: 'withdraw', id: poster(one, 1).versionId });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal((withdrawn.body['decision'] as Record<string, unknown>)['status'], 'rejected');
    assert.deepEqual(engine.seen.at(-1)?.body, { reason: 'other', comment: 'withdrawn by the customer' });
    expectError(await decide({ action: 'withdraw', id: poster(one, 6).versionId }), 409, 'CONFLICT', 'a picture that was never approved cannot be withdrawn');

    expectError(await decide({ action: 'approve', id: poster(one, 4).versionId }), 409, 'POSTER_SUPERSEDED', 'replaced by a newer one');
    expectError(await decide({ action: 'approve', id: poster(one, 5).versionId }), 409, 'POSTER_BLOCKED', 'did not pass the checks');
    expectError(await decide({ action: 'reject', id: poster(one, 6).versionId }), 400, 'INVALID_REASON', 'a reason is needed');
    expectError(await decide({ action: 'reject', id: poster(one, 6).versionId, reason: 'because' }), 400, 'INVALID_REASON', 'not one of the reasons');
    expectError(await decide({ action: 'reject', id: poster(one, 6).versionId, reason: 'other', comment: 'x'.repeat(501) }), 400, 'INVALID_REQUEST', 'comment too long');
    expectError(await decide({ action: 'approve', id: poster(one, 6).versionId }, {}), 400, 'ACTOR_REQUIRED', 'a person is needed');
    expectError(await decide({ action: 'explode', id: 'x' }), 400, 'INVALID_REQUEST', 'unknown action');
    expectError(await decide({ action: 'approve' }), 400, 'INVALID_REQUEST', 'id missing');
    expectError(await decide({ action: 'approve', id: `${one}.${sha(99)}` }), 404, 'NOT_FOUND', 'no such picture');
  });
});

test('posters: one customer cannot decide another\'s picture', async () => {
  await withEngine(async (engine) => {
    await workspace('shop-1');
    const two = await workspace('shop-2');
    engine.posters.push(poster(two, 7));
    const before = engine.seen.length;
    expectError(await decide({ action: 'approve', id: poster(two, 7).versionId }), 404, 'NOT_FOUND', 'foreign picture');
    expectError(await decide({ action: 'approve', id: poster(two, 7).versionId }, act, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    assert.equal(engine.posters[0]?.status, 'pending');
    assert.equal(engine.seen.length, before, 'nothing reached the engine');
  });
});

test('posters: a blocked or held picture says in plain words what the customer can do', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    engine.posters.push(poster(one, 1, { status: 'blocked' }), poster(one, 2, { status: 'held' }), poster(one, 3));
    const all = (await call(postersGet, '/api/v1/posters?externalId=shop-1&status=all')).body['posters'] as Array<Record<string, unknown>>;
    const by = (id: string): Record<string, unknown> => all.find((p) => p['id'] === id) as Record<string, unknown>;
    assert.match(String(by(poster(one, 1).versionId)['notice']), /did not pass our checks.*Draw a new one/);
    assert.match(String(by(poster(one, 2).versionId)['notice']), /confirm again/i);
    assert.equal(by(poster(one, 3).versionId)['notice'], undefined);
    assert.doesNotMatch(JSON.stringify(all), /defect|reason|\/home/);
  });
});

test('redraw: one more picture for one network, once per poster, and never while approved', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    engine.posters.push(poster(one, 1, { status: 'blocked' }), poster(one, 2, { status: 'approved' }), poster(one, 3, { redrawsLeft: 0 }));
    const made = await decide({ action: 'redraw', id: poster(one, 1).versionId });
    assert.equal(made.status, 202, JSON.stringify(made.body));
    assert.deepEqual([(made.body['job'] as Record<string, unknown>)['kind'], made.body['created']], ['draw', true]);
    assert.deepEqual([engine.seen.at(-1)?.url, engine.seen.at(-1)?.actor], [`/review/posts/${poster(one, 1).versionId}/redraw`, 'brandbasket:user_42']);
    const waiting = await decide({ action: 'redraw', id: poster(one, 1).versionId });
    assert.equal(waiting.status, 409, 'the allowance is used, so a second ask is refused');
    assert.equal(waiting.body['code'], 'REDRAW_LIMIT_REACHED');
    expectError(await decide({ action: 'redraw', id: poster(one, 2).versionId }), 409, 'CONFLICT', 'approved: withdraw first');
    expectError(await decide({ action: 'redraw', id: poster(one, 3).versionId }), 409, 'REDRAW_LIMIT_REACHED', 'no tries left');
    expectError(await decide({ action: 'redraw', id: poster(one, 1).versionId }, {}), 400, 'ACTOR_REQUIRED', 'a person is needed');
    expectError(await decide({ action: 'redraw', id: `${one}.${sha(99)}` }), 404, 'NOT_FOUND', 'no such picture');
  });
});

// A post the engine has released into the publisher's schedule: `<workspace brand>-<post id>`, going to LinkedIn.
async function released(brand: string, postId: string, connectedAt: number = Date.now() - 3_600_000): Promise<string> {
  const { loadChannels, saveChannels } = await import('./store.ts');
  const { addLinkedInMember } = await import('./channels.ts');
  const { parseKey } = await import('./crypto.ts');
  const { CHANNEL_KEY } = await import('../dev/product-test-kit.ts');
  const { file, etag } = await loadChannels();
  await saveChannels(addLinkedInMember(file, brand, { urn: 'urn:li:person:abcdefabc', name: 'T' }, 'token', 5_000_000, parseKey(CHANNEL_KEY), connectedAt), etag);
  const id = `${brand}-${postId}`;
  const { releasedSchedule } = await import('./customer-skip.ts');
  releasedSchedule.read = () => [{ brand, id, date: new Date(Date.now() + 86_400_000).toISOString(), caption: 'c', image: null, fromPlan: true, channels: ['linkedin'] }];
  return id;
}

const overridesOf = async (): Promise<Record<string, Record<string, unknown>>> => (await (await import('./store.ts')).loadOverrides()).overrides as unknown as Record<string, Record<string, unknown>>;

test('withdraw: a post already in the schedule is stopped at once, and approving again lets it go ahead', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const id = await released(one, 'w01-d1');
    engine.posters.push(poster(one, 1, { status: 'approved', network: 'linkedin' }));
    const withdrawn = await decide({ action: 'withdraw', id: poster(one, 1).versionId });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body['postStopped'], true);
    assert.equal((await overridesOf())[id]?.['skipped'], true);
    assert.equal((await overridesOf())[id]?.['skippedBy'], 'customer');
    engine.posters[0]!.status = 'pending';
    // Approved again while the schedule still holds what it held: the post stays stopped until the release pass has caught up.
    const again = await decide({ action: 'approve', id: poster(one, 1).versionId });
    assert.equal(again.status, 200);
    assert.equal(again.body['waitingForRelease'], true);
    assert.equal((await overridesOf())[id]?.['skipped'], true);
    // The release pass then writes the approved words into the schedule, and the next look lets the post go ahead.
    const { releasedSchedule } = await import('./customer-skip.ts');
    const was = releasedSchedule.read();
    releasedSchedule.read = () => was.map((p) => ({ ...p, caption: 'Words', variants: { linkedin: { caption: 'Words' } } }));
    const { reconcileCustomerSkips } = await import('./product-watch.ts');
    const { engineFromEnv, WorkspaceEngine } = await import('./engine-client.ts');
    assert.equal(await reconcileCustomerSkips(one, new WorkspaceEngine(engineFromEnv() as NonNullable<ReturnType<typeof engineFromEnv>>, 'brandbasket', one), 'brandbasket:service', Date.now()), 1);
    assert.deepEqual(await overridesOf(), {}, 'the customer\'s skip is gone');
    // Approving when the schedule is already right lets it go ahead at once.
    engine.posters[0]!.status = 'approved';
    await decide({ action: 'withdraw', id: poster(one, 1).versionId });
    engine.posters[0]!.status = 'pending';
    const quick = await decide({ action: 'approve', id: poster(one, 1).versionId });
    assert.equal(quick.body['waitingForRelease'], undefined);
    assert.deepEqual(await overridesOf(), {});
  });
});

test('withdraw: a post that stays approved on another network is left to the engine\'s next pass', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const id = await released(one, 'w01-d1');
    engine.posters.push(poster(one, 1, { status: 'approved', network: 'linkedin' }), poster(one, 2, { status: 'approved', network: 'instagram' }));
    const withdrawn = await decide({ action: 'withdraw', id: poster(one, 1).versionId });
    assert.equal(withdrawn.body['postStopped'], false);
    assert.equal((await overridesOf())[id], undefined);
  });
});

test('withdraw: a post that has already gone out cannot be withdrawn, and the engine is not told', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const id = await released(one, 'w01-d1');
    const { loadPosted, savePosted } = await import('./store.ts');
    const { postedKey } = await import('./channels.ts');
    const { loadChannels } = await import('./store.ts');
    const channel = (await loadChannels()).file.channels[0] as { id: string };
    const { log, etag } = await loadPosted();
    await savePosted({ ...log, [postedKey(id, channel.id)]: { remoteId: 'r1', permalink: 'https://l/1', postedAt: new Date().toISOString() } }, etag);
    engine.posters.push(poster(one, 1, { status: 'approved', network: 'linkedin' }));
    expectError(await decide({ action: 'withdraw', id: poster(one, 1).versionId }), 409, 'POST_ALREADY_SENT', 'gone out');
    assert.equal(engine.posters[0]?.status, 'approved');
  });
});

test('withdraw: the team\'s own skip is never undone by the customer approving again, and a post never released is just withdrawn', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const id = await released(one, 'w01-d1');
    const { loadOverrides, saveOverrides } = await import('./store.ts');
    const { overrides, etag } = await loadOverrides();
    await saveOverrides({ ...overrides, [id]: { skipped: true, updatedAt: new Date().toISOString() } }, etag);
    engine.posters.push(poster(one, 1, { status: 'pending', network: 'linkedin' }), poster(one, 2, { status: 'approved', network: 'linkedin', postId: 'w01-d9' }));
    assert.equal((await decide({ action: 'approve', id: poster(one, 1).versionId })).status, 200);
    assert.equal((await overridesOf())[id]?.['skipped'], true, 'the team\'s skip stays');
    const never = await decide({ action: 'withdraw', id: poster(one, 2).versionId });
    assert.equal(never.status, 200, JSON.stringify(never.body));
    assert.equal(never.body['postStopped'], false);
  });
});

test('a blocked picture can be put away by the customer with a reject, and still cannot be approved', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    engine.posters.push(poster(one, 1, { status: 'blocked' }));
    expectError(await decide({ action: 'approve', id: poster(one, 1).versionId }), 409, 'POSTER_BLOCKED', 'a blocked picture is never approved');
    const away = await decide({ action: 'reject', id: poster(one, 1).versionId, reason: 'other' });
    assert.equal(away.status, 200, JSON.stringify(away.body));
    assert.equal((away.body['decision'] as Record<string, unknown>)['status'], 'rejected');
  });
});

const words = (json: Record<string, unknown>, headers: Record<string, string> = act): Promise<Answer> => decide({ action: 'change-words', ...json }, headers);

test('change words: a new waiting version of the same picture; the old approval is replaced and the post is held until she approves again', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const id = await released(one, 'w01-d1');
    engine.posters.push(poster(one, 1, { status: 'approved', network: 'linkedin' }));
    const changed = await words({ id: poster(one, 1).versionId, caption: 'Come and taste our laddoos.' });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const poster1 = changed.body['poster'] as Record<string, unknown>;
    assert.deepEqual([poster1['status'], poster1['caption'], poster1['versionNumber']], ['pending', 'Come and taste our laddoos.', 2]);
    assert.notEqual(poster1['id'], poster(one, 1).versionId);
    assert.equal(changed.body['postStopped'], true, 'nothing else is approved, so the post is stopped now');
    assert.equal((await overridesOf())[id]?.['skippedBy'], 'customer');
    assert.equal(engine.posters[0]?.status, 'superseded');
    assert.ok(engine.seen.some((r) => r.url.endsWith('/words') && JSON.stringify(r.body) === '{"caption":"Come and taste our laddoos."}'), 'the engine was asked with the words only');
  });
});

test('change words: what is refused, and why', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const id = await released(one, 'w01-d1');
    engine.posters.push(poster(one, 1, { status: 'pending' }), poster(one, 2, { status: 'blocked' }), poster(one, 3, { status: 'superseded' }), poster(one, 4, { status: 'approved', network: 'linkedin', postId: 'w01-d1' }));
    expectError(await words({ id: poster(one, 1).versionId, headline: 'New' , caption: 'x'}), 400, 'INVALID_REQUEST', 'the headline is on the picture');
    expectError(await words({ id: poster(one, 1).versionId }), 400, 'CAPTION_REQUIRED', 'no words');
    expectError(await words({ id: poster(one, 1).versionId, caption: '   ' }), 400, 'CAPTION_REQUIRED', 'blank words');
    expectError(await words({ id: poster(one, 1).versionId, caption: 'x'.repeat(3001) }), 400, 'CAPTION_TOO_LONG', 'too long');
    expectError(await words({ id: poster(one, 1).versionId, caption: 'Words' }), 400, 'NOTHING_TO_CHANGE', 'the same words');
    expectError(await words({ id: poster(one, 1).versionId, caption: 'we are number one BADFACT' }), 422, 'WORDS_NOT_ACCEPTED', 'claims and length');
    expectError(await words({ id: poster(one, 2).versionId, caption: 'fine words' }), 409, 'POSTER_BLOCKED', 'a blocked picture');
    expectError(await words({ id: poster(one, 3).versionId, caption: 'fine words' }), 409, 'POSTER_SUPERSEDED', 'an old version');
    expectError(await words({ id: poster(one, 1).versionId, caption: 'fine words' }, {}), 400, 'ACTOR_REQUIRED', 'a person is needed');
    expectError(await words({ id: `${one}.${sha(99)}`, caption: 'fine words' }), 404, 'NOT_FOUND', 'no such picture');
    // An approved picture whose post has already gone out cannot get new words, and the engine is not asked.
    const { loadPosted, savePosted, loadChannels } = await import('./store.ts');
    const { postedKey } = await import('./channels.ts');
    const channel = (await loadChannels()).file.channels[0] as { id: string };
    const { log, etag } = await loadPosted();
    await savePosted({ ...log, [postedKey(id, channel.id)]: { remoteId: 'r1', permalink: null, postedAt: new Date().toISOString() } }, etag);
    const before = engine.seen.filter((s) => s.url.endsWith('/words')).length;
    expectError(await words({ id: poster(one, 4).versionId, caption: 'fine words' }), 409, 'POST_ALREADY_SENT', 'gone out');
    assert.equal(engine.seen.filter((s) => s.url.endsWith('/words')).length, before);
  });
});

test('expired: a picture nobody decided on in time is "expired" in the list, the filter and the detail; an expired written batch is listed apart', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const gone = poster(one, 1, { status: 'rejected', rejectedFor: 'expired' });
    engine.posters.push(gone, poster(one, 2, { status: 'rejected', rejectedFor: 'weak_copy' }), poster(one, 3));
    const at = new Date(Date.now() - 86_400_000).toISOString();
    engine.expired.push({ at, brand: one, kind: 'poster', planFile: 'week-01.json', postId: 'w01-d1', network: 'linkedin', versionId: gone.versionId }, { at, brand: one, kind: 'batch', planFile: 'week-00.json' });
    const statusOf = async (q: string): Promise<Record<string, string>> => Object.fromEntries(((await call(postersGet, `/api/v1/posters?externalId=shop-1&status=${q}`)).body['posters'] as Array<Record<string, string>>).map((p) => [p['id'] as string, p['status'] as string]));
    assert.deepEqual(await statusOf('all'), { [gone.versionId]: 'expired', [poster(one, 2).versionId]: 'rejected', [poster(one, 3).versionId]: 'pending' });
    assert.deepEqual(await statusOf('expired'), { [gone.versionId]: 'expired' });
    assert.deepEqual(await statusOf('rejected'), { [gone.versionId]: 'expired', [poster(one, 2).versionId]: 'rejected' });
    assert.deepEqual(await statusOf('pending'), { [poster(one, 3).versionId]: 'pending' });
    const detail = await call(postersGet, `/api/v1/posters?externalId=shop-1&id=${gone.versionId}`);
    assert.equal((detail.body['poster'] as Record<string, unknown>)['status'], 'expired');
    const batches = await call(batchesGet, '/api/v1/batches?externalId=shop-1');
    assert.deepEqual(batches.body['expired'], [{ id: 'week-00.json', expiredAt: at }]);
  });
});

test('sharedWith: the other networks whose current picture of the same post is the same drawing; a redraw and a newer version end the sharing', async () => {
  await withEngine(async (engine) => {
    const one = await workspace('shop-1');
    const square = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    engine.posters.push(
      poster(one, 1, { network: 'instagram', status: 'approved', imageSha256: square }),
      poster(one, 2, { network: 'facebook', status: 'pending', imageSha256: square }),
      poster(one, 3, { network: 'google', status: 'pending', imageSha256: square }),
      poster(one, 4, { network: 'linkedin', status: 'approved', imageSha256: other }),
      poster(one, 5, { postId: 'w01-d2', network: 'instagram', status: 'pending', imageSha256: other }),
    );
    const read = async (q = 'all'): Promise<Record<string, string[] | undefined>> => Object.fromEntries(((await call(postersGet, `/api/v1/posters?externalId=shop-1&status=${q}`)).body['posters'] as Array<Record<string, unknown>>).map((p) => [`${p['postId']}/${p['network']}`, p['sharedWith'] as string[] | undefined]));
    assert.deepEqual(await read(), { 'w01-d1/instagram': ['facebook', 'google'], 'w01-d1/facebook': ['instagram', 'google'], 'w01-d1/google': ['instagram', 'facebook'], 'w01-d1/linkedin': undefined, 'w01-d2/instagram': undefined });
    // The sharing is known whatever status is asked for: Facebook is pending and Instagram approved.
    assert.deepEqual(await read('pending'), { 'w01-d1/facebook': ['instagram', 'google'], 'w01-d1/google': ['instagram', 'facebook'], 'w01-d2/instagram': undefined });
    const detail = await call(postersGet, `/api/v1/posters?externalId=shop-1&id=${poster(one, 2).versionId}`);
    assert.deepEqual((detail.body['poster'] as Record<string, unknown>)['sharedWith'], ['instagram', 'google']);
    assert.doesNotMatch(JSON.stringify(await call(postersGet, '/api/v1/posters?externalId=shop-1')), /imageSha256|aaaaaaaa/);

    // Instagram is redrawn: its new picture is a different image, so Facebook and Google no longer share with it, but still with each other.
    engine.posters[0]!.status = 'superseded';
    engine.posters.push(poster(one, 6, { network: 'instagram', versionNumber: 2, status: 'pending', imageSha256: 'c'.repeat(64) }));
    const after = await read();
    assert.deepEqual([after['w01-d1/instagram'], after['w01-d1/facebook'], after['w01-d1/google']], [undefined, ['google'], ['facebook']]);
    // A new network reusing a picture of the same shape shares it with that network.
    engine.posters.push(poster(one, 7, { network: 'linkedin', versionNumber: 2, status: 'pending', imageSha256: 'c'.repeat(64) }));
    assert.deepEqual((await read())['w01-d1/instagram'], ['linkedin']);
  });
});
