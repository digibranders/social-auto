import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as eventsGet } from '../api/_v1/events.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, fakeEngine, OTHER_KEY, withProducts, type FakeEngine } from '../dev/product-test-kit.ts';
import { publishEvents, retryDueEvents } from './events.ts';
import { addEntries, dueEntries, EMPTY_OUTBOX, eventsAfter, MAX_ATTEMPTS, parseOutbox, recordAttempt, RETENTION_MS, RETRY_DELAYS_MS, trimmed } from './outbox.ts';
import { announceEngineProgress, eventsForProgress, expiringSoon } from './product-watch.ts';
import { GET as postersGet } from '../api/_v1/posters.ts';
import { engineFromEnv } from './engine-client.ts';
import type { Product } from './products.ts';
import { loadClients, loadOutbox, saveClients } from './store.ts';
import { newEvent, verifySignature } from './webhooks.ts';
import { setWebsite } from './clients.ts';

const SECRET = 'whsec_' + 'x'.repeat(20);
const NOW = Date.parse('2026-11-20T05:00:00Z');
const product: Product = { id: 'brandbasket', keyHash: 'h'.repeat(64), returnUrls: [], webhookUrl: 'https://app.brandbasket.in/api/webhooks/social', webhookSecret: SECRET };
const readOnly: Product = { id: 'otherapp', keyHash: 'g'.repeat(64), returnUrls: [] };
const ev = (n: number): { product: string; event: ReturnType<typeof newEvent> } => ({ product: 'brandbasket', event: newEvent('poster.ready', { externalId: 'shop-1', n }, NOW) });

/** A pretend product: answers with the given statuses in turn and keeps what it was sent. */
function receiver(statuses: number[]): { send: typeof fetch; got: Array<{ body: string; signature: string | null }> } {
  const got: Array<{ body: string; signature: string | null }> = [];
  const send = (async (_url: string, init: RequestInit) => {
    got.push({ body: String(init.body), signature: new Headers(init.headers).get('X-Social-Signature') });
    return new Response('', { status: statuses[Math.min(got.length - 1, statuses.length - 1)] ?? 200 });
  }) as unknown as typeof fetch;
  return { send, got };
}

test('the log gives each event its own place, and a product without a webhook only reads', () => {
  const { outbox, added } = addEntries(EMPTY_OUTBOX, [ev(1), { ...ev(2), product: 'otherapp' }], (id) => id === 'brandbasket', NOW);
  assert.deepEqual(added.map((e) => [e.seq, e.event.seq, e.nextAttemptAt !== null]), [[1, 1, true], [2, 2, false]]);
  assert.equal(outbox.nextSeq, 3);
  assert.deepEqual(dueEntries(outbox, NOW).map((e) => e.seq), [1]);
  assert.deepEqual(eventsAfter(outbox, 'brandbasket', 0, 10).events.map((e) => e.seq), [1], 'only its own events');
  assert.deepEqual(parseOutbox(JSON.parse(JSON.stringify(outbox))), outbox);
  assert.throws(() => parseOutbox({ nextSeq: 1 }), /not a valid event log/);
  assert.throws(() => parseOutbox({ nextSeq: 1, entries: [{ seq: 1 }], announced: [] }), /damaged/);
});

test('a failed delivery is retried after growing waits and given up on after the last try', () => {
  let { outbox } = addEntries(EMPTY_OUTBOX, [ev(1)], () => true, NOW);
  let at = NOW;
  for (let n = 1; n <= RETRY_DELAYS_MS.length; n += 1) {
    outbox = recordAttempt(outbox, 1, false, at);
    const entry = outbox.entries[0]!;
    assert.equal(entry.attempts, n);
    assert.equal(Date.parse(entry.nextAttemptAt as string), at + (RETRY_DELAYS_MS[n - 1] as number));
    assert.deepEqual(dueEntries(outbox, at), [], 'not yet');
    at += RETRY_DELAYS_MS[n - 1] as number;
    assert.equal(dueEntries(outbox, at).length, 1, 'due when the wait is over');
  }
  outbox = recordAttempt(outbox, 1, false, at);
  assert.equal(outbox.entries[0]?.attempts, MAX_ATTEMPTS);
  assert.ok(outbox.entries[0]?.gaveUpAt);
  assert.deepEqual(dueEntries(outbox, at + 1e12), []);
  assert.equal(eventsAfter(outbox, 'brandbasket', 0, 10).events.length, 1, 'a given-up event can still be read');
  const done = recordAttempt(addEntries(EMPTY_OUTBOX, [ev(2)], () => true, NOW).outbox, 1, true, NOW);
  assert.ok(done.entries[0]?.deliveredAt);
  assert.deepEqual(dueEntries(done, NOW + 1e12), []);
});

test('old events and old announcements are dropped, newest kept', () => {
  const stale = { product: 'brandbasket', event: newEvent('poster.ready', { externalId: 'shop-1' }, NOW - RETENTION_MS - 1000) };
  const mixed = addEntries(addEntries(EMPTY_OUTBOX, [stale], () => true, NOW).outbox, [ev(2)], () => true, NOW).outbox;
  assert.deepEqual(trimmed(mixed, NOW).entries.map((e) => e.seq), [2]);
});

test('an event is written down, delivered signed with its place, and delivered once', async () => {
  await withProducts(async () => {
    const pretend = receiver([200]);
    await publishEvents([ev(1)], [product], { now: NOW, send: pretend.send });
    assert.equal(pretend.got.length, 1);
    const sent = JSON.parse(pretend.got[0]?.body as string) as Record<string, unknown>;
    assert.equal(sent['seq'], 1);
    assert.equal(verifySignature(SECRET, pretend.got[0]?.body as string, pretend.got[0]?.signature ?? null, Math.floor(Date.now() / 1000)), true);
    const { outbox } = await loadOutbox();
    assert.ok(outbox.entries[0]?.deliveredAt);
    await retryDueEvents([product], NOW + 1e10, pretend.send);
    assert.equal(pretend.got.length, 1, 'a delivered event is not sent again');
  });
});

test('a product that is down gets the event again later, and can read it meanwhile', async () => {
  await withProducts(async () => {
    const down = receiver([500]);
    await publishEvents([ev(1), ev(2)], [product], { now: NOW, send: down.send });
    assert.equal(down.got.length, 2);
    const early = receiver([200]);
    await retryDueEvents([product], NOW + 30_000, early.send);
    assert.equal(early.got.length, 0, 'not before the wait is over');
    const back = receiver([200]);
    await retryDueEvents([product], NOW + 61_000, back.send);
    assert.deepEqual(back.got.map((g) => (JSON.parse(g.body) as { seq: number }).seq), [1, 2], 'in order');
    const { outbox } = await loadOutbox();
    assert.ok(outbox.entries.every((e) => e.deliveredAt && e.attempts === 2));
  });
});

test('a product with no webhook address is never called, and a refused address is not followed', async () => {
  await withProducts(async () => {
    const pretend = receiver([200]);
    await publishEvents([{ ...ev(1), product: 'otherapp' }], [readOnly], { now: NOW, send: pretend.send });
    assert.equal(pretend.got.length, 0);
    assert.equal((await loadOutbox()).outbox.entries.length, 1, 'but the event is kept to be read');
    const throwing = (async () => { throw new Error('connect ECONNREFUSED 10.0.0.5'); }) as unknown as typeof fetch;
    await publishEvents([ev(2)], [product], { now: NOW, send: throwing });
    assert.equal((await loadOutbox()).outbox.entries[1]?.attempts, 1);
  });
});

test('GET /api/v1/events gives a product its own events after the one it last saw', async () => {
  await withProducts(async () => {
    const pretend = receiver([200]);
    await publishEvents([ev(1), ev(2), ev(3), { ...ev(9), product: 'otherapp' }], [product, readOnly], { now: NOW, send: pretend.send });
    const all = await call(eventsGet, '/api/v1/events');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.deepEqual((all.body['events'] as Array<{ seq: number }>).map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(Object.keys((all.body['events'] as object[])[0] as object).sort(), ['createdAt', 'data', 'id', 'seq', 'type']);
    const page = await call(eventsGet, '/api/v1/events?after=1&limit=1');
    assert.deepEqual([(page.body['events'] as Array<{ seq: number }>).map((e) => e.seq), page.body['hasMore']], [[2], true]);
    assert.deepEqual((await call(eventsGet, '/api/v1/events?after=3')).body, { events: [], hasMore: false });
    const other = await call(eventsGet, '/api/v1/events', { key: OTHER_KEY });
    assert.deepEqual((other.body['events'] as Array<{ seq: number }>).map((e) => e.seq), [4], 'another product reads only its own');
    for (const bad of ['after=-1', 'after=x', 'limit=0', 'limit=101', 'limit=1.5']) {
      const answer = await call(eventsGet, `/api/v1/events?${bad}`);
      assert.deepEqual([answer.status, answer.body['code']], [400, 'INVALID_REQUEST'], bad);
    }
    assert.equal((await call(eventsGet, '/api/v1/events', { key: null })).status, 401);
  });
});

test('progress: a finished job and a waiting picture are announced once each', () => {
  const owner = { product: 'brandbasket', externalId: 'shop-1' };
  const progress = {
    jobs: [{ id: 'job-a', kind: 'write', state: 'done' }, { id: 'job-b', kind: 'draw', state: 'running' }, { id: 'job-c', kind: 'draw', state: 'failed', batchId: 'week-01.json' }],
    posters: [{ id: 'p1', batchId: 'week-01.json', postId: 'w01-d1', network: 'linkedin' }],
  };
  const first = eventsForProgress(owner, progress, { announced: [] }, NOW);
  assert.deepEqual(first.items.map((i) => i.event.type), ['job.finished', 'job.finished', 'poster.ready']);
  assert.deepEqual(first.items[1]?.event.data, { externalId: 'shop-1', jobId: 'job-c', kind: 'draw', state: 'failed', batchId: 'week-01.json' });
  assert.deepEqual(first.announced, ['job:job-a', 'job:job-c', 'poster:p1']);
  assert.deepEqual(eventsForProgress(owner, progress, { announced: first.announced }, NOW).items, []);
});

async function withWatchedEngine(run: (engine: FakeEngine, brand: string, pretend: ReturnType<typeof receiver>) => Promise<void>): Promise<void> {
  await withProducts(async () => {
    const engine = await fakeEngine();
    try {
      const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'shop-1' } });
      const brand = String((made.body['workspace'] as { id: string }).id);
      const { file, etag } = await loadClients();
      await saveClients(setWebsite(file, brand, 'https://acme.example.com'), etag);
      await run(engine, brand, receiver([200]));
    } finally {
      await engine.close();
    }
  });
}

test('the cron scan tells the product about finished jobs and ready pictures, once, with nothing from other customers', async () => {
  await withWatchedEngine(async (engine, brand, pretend) => {
    engine.jobs.push({ id: 'job-a00001-0123abcd', key: 'copy', kind: 'copy', brand, site: 'https://acme.example.com', by: 'x', networks: [], state: 'succeeded', createdAt: new Date(NOW).toISOString() });
    engine.jobs.push({ id: 'job-a00002-0123abcd', key: 'copy', kind: 'copy', brand: 'someone-else', site: 'https://x.example', by: 'x', networks: [], state: 'succeeded', createdAt: new Date(NOW).toISOString() });
    engine.posters.push({ versionId: `${brand}.${'a'.repeat(16)}`, brand, postId: 'w01-d1', planFile: 'week-01.json', versionNumber: 1, network: 'linkedin', status: 'pending', headline: 'h', caption: 'c', width: 1, height: 1, shape: 'square', createdAt: new Date(NOW).toISOString(), costUsd: 1 });
    const config = engineFromEnv();
    await announceEngineProgress([product], NOW, config, pretend.send);
    const bodies = pretend.got.map((g) => JSON.parse(g.body) as { type: string; data: Record<string, unknown> });
    assert.deepEqual(bodies.map((b) => b.type).sort(), ['job.finished', 'poster.ready']);
    assert.doesNotMatch(JSON.stringify(bodies), /someone-else|costUsd|\/home/);
    assert.equal(bodies.find((b) => b.type === 'poster.ready')?.data['externalId'], 'shop-1');
    await announceEngineProgress([product], NOW + 120_000, config, pretend.send);
    assert.equal(pretend.got.length, 2, 'nothing is announced twice');
    engine.posters[0]!.status = 'approved';
    engine.posters.push({ ...engine.posters[0]!, versionId: `${brand}.${'b'.repeat(16)}`, status: 'pending', versionNumber: 2 });
    await announceEngineProgress([product], NOW + 240_000, config, pretend.send);
    assert.equal(pretend.got.length, 3, 'a new picture is announced');
  });
});

test('the scan survives an engine that is down and a customer whose look fails', async () => {
  await withWatchedEngine(async (engine, _brand, pretend) => {
    await engine.close();
    await announceEngineProgress([product], NOW, engineFromEnv(), pretend.send);
    assert.equal(pretend.got.length, 0);
    assert.equal((await loadOutbox()).outbox.announced.length, 0, 'nothing is marked announced when nothing was seen');
  });
});

const DAY = 24 * 3_600_000;
const posterAt = (daysAgo: number, id = 'p1'): Parameters<typeof expiringSoon>[0][number] => ({ id, batchId: 'week-01.json', postId: 'w01-d1', network: 'linkedin', shape: 'square', width: 1, height: 1, headline: 'h', caption: 'c', versionNumber: 1, status: 'pending', canRedraw: true, redrawsLeft: 1, createdAt: new Date(NOW - daysAgo * DAY).toISOString() });

test('expiry: a waiting picture or batch is warned about 2 days before 14, and only then', () => {
  const batch = (daysAgo: number): Parameters<typeof expiringSoon>[1][number] => ({ id: 'week-01.json', createdAt: new Date(NOW - daysAgo * DAY).toISOString(), networks: [], posts: [] });
  assert.deepEqual(expiringSoon([posterAt(11)], [batch(5)], NOW), [], 'too early');
  assert.deepEqual(expiringSoon([posterAt(14.5)], [batch(15)], NOW), [], 'too late: it is already put away');
  const soon = expiringSoon([posterAt(12.5), { ...posterAt(12.5, 'p2'), status: 'approved' }], [batch(13)], NOW);
  assert.deepEqual(soon.map((e) => [e.kind, e.posterId ?? e.batchId]), [['poster', 'p1'], ['batch', 'week-01.json']], 'an approved picture does not expire');
  assert.equal(soon[0]?.expiresAt, new Date(NOW + 1.5 * DAY).toISOString());
});

test('expiry: the warning and the put-away are each announced once, with where they happened', () => {
  const owner = { product: 'brandbasket', externalId: 'shop-1' };
  const progress = {
    jobs: [], posters: [],
    expiring: [{ kind: 'poster' as const, batchId: 'week-01.json', postId: 'w01-d1', network: 'linkedin', posterId: 'p1', expiresAt: '2026-11-21T00:00:00.000Z' }],
    expired: [{ at: '2026-11-19T00:00:00.000Z', kind: 'batch' as const, batchId: 'week-00.json' }],
  };
  const first = eventsForProgress(owner, progress, { announced: [] }, NOW);
  assert.deepEqual(first.items.map((i) => i.event.type), ['poster.expiring', 'poster.expired']);
  assert.deepEqual(first.items[0]?.event.data, { externalId: 'shop-1', kind: 'poster', batchId: 'week-01.json', postId: 'w01-d1', network: 'linkedin', posterId: 'p1', expiresAt: '2026-11-21T00:00:00.000Z' });
  assert.deepEqual(first.items[1]?.event.data, { externalId: 'shop-1', kind: 'batch', batchId: 'week-00.json', expiredAt: '2026-11-19T00:00:00.000Z' });
  assert.deepEqual(eventsForProgress(owner, progress, { announced: first.announced }, NOW).items, []);
});

test('expiry: the scan reads what the engine put away, and a picture put away that way shows as expired', async () => {
  await withWatchedEngine(async (engine, brand, pretend) => {
    const id = `${brand}.${'c'.repeat(16)}`;
    engine.posters.push({ versionId: id, brand, postId: 'w01-d1', planFile: 'week-01.json', versionNumber: 1, network: 'linkedin', status: 'rejected', rejectedFor: 'expired', headline: 'h', caption: 'c', width: 1, height: 1, shape: 'square', createdAt: new Date(NOW - 15 * DAY).toISOString(), costUsd: 1 });
    engine.expired.push({ at: new Date(NOW - DAY).toISOString(), brand, kind: 'poster', planFile: 'week-01.json', postId: 'w01-d1', network: 'linkedin', versionId: id }, { at: new Date(NOW - DAY).toISOString(), brand: 'someone-else', kind: 'batch', planFile: 'week-09.json' });
    await announceEngineProgress([product], NOW, engineFromEnv(), pretend.send);
    const bodies = pretend.got.map((g) => JSON.parse(g.body) as { type: string; data: Record<string, unknown> });
    assert.deepEqual(bodies.map((b) => b.type), ['poster.expired']);
    assert.equal(bodies[0]?.data['posterId'], id);
    const detail = await call(postersGet, `/api/v1/posters?externalId=shop-1&id=${id}`);
    assert.equal((detail.body['poster'] as Record<string, unknown>)['status'], 'expired');
  });
});

test('progress: a picture the system approved is announced once, with where and when it goes out', () => {
  const owner = { product: 'brandbasket', externalId: 'shop-1' };
  const progress = { jobs: [], posters: [], autoApproved: [{ id: 'p1', batchId: 'week-01.json', postId: 'w01-d1', network: 'instagram', date: '2026-11-16', time: '10:00' }, { id: 'p2', batchId: 'week-01.json', postId: 'w01-d2', network: 'instagram' }] };
  const first = eventsForProgress(owner, progress, { announced: [] }, NOW);
  assert.deepEqual(first.items.map((i) => i.event.type), ['poster.auto_approved', 'poster.auto_approved']);
  assert.deepEqual(first.items[0]?.event.data, { externalId: 'shop-1', posterId: 'p1', batchId: 'week-01.json', postId: 'w01-d1', network: 'instagram', date: '2026-11-16', time: '10:00' });
  assert.deepEqual(first.announced, ['auto-approved:p1', 'auto-approved:p2']);
  assert.deepEqual(eventsForProgress(owner, progress, { announced: first.announced }, NOW).items, [], 'once');
});

test('the cron scan announces only the pictures the system approved, and the poster list marks them; one a person approved is not announced', async () => {
  const { GET: postersGet } = await import('../api/_v1/posters.ts');
  await withWatchedEngine(async (engine, brand, pretend) => {
    const base = { brand, postId: 'w01-d1', planFile: 'week-01.json', versionNumber: 1, network: 'instagram', status: 'approved' as const, headline: 'h', caption: 'c', width: 1, height: 1, shape: 'square', createdAt: new Date(NOW).toISOString(), costUsd: 0 };
    engine.posters.push({ ...base, versionId: `${brand}.${'a'.repeat(16)}`, decidedBy: 'system:auto-posting', date: '2026-11-16', time: '10:00' });
    engine.posters.push({ ...base, versionId: `${brand}.${'b'.repeat(16)}`, postId: 'w01-d2', decidedBy: 'brandbasket:u1' });
    await announceEngineProgress([product], NOW, engineFromEnv(), pretend.send);
    const bodies = pretend.got.map((g) => JSON.parse(g.body) as { type: string; data: Record<string, unknown> });
    assert.deepEqual(bodies.map((b) => b.type), ['poster.auto_approved']);
    assert.deepEqual([bodies[0]?.data['posterId'], bodies[0]?.data['date'], bodies[0]?.data['time']], [`${brand}.${'a'.repeat(16)}`, '2026-11-16', '10:00']);
    await announceEngineProgress([product], NOW + 120_000, engineFromEnv(), pretend.send);
    assert.equal(pretend.got.length, 1, 'told once');
    const listed = await call(postersGet, '/api/v1/posters?externalId=shop-1&status=approved');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const posters = listed.body['posters'] as Array<{ postId: string; autoApproved?: boolean }>;
    assert.deepEqual(posters.map((p) => [p.postId, p.autoApproved ?? false]).sort(), [['w01-d1', true], ['w01-d2', false]]);
  });
});
