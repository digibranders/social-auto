import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET as requestsGet, POST as requestsPost, topicDay } from '../api/_v1/topic-requests.ts';
import { POST as archivePost } from '../api/_v1/workspace-archive.ts';
import { POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { call, CHANNEL_KEY, fakeEngine, OTHER_KEY, withProducts, type Answer, type FakeEngine } from '../dev/product-test-kit.ts';
import { ERROR_CODES, type ErrorCode } from './api-error.ts';
import { addLinkedInMember } from './channels.ts';
import { setWebsite } from './clients.ts';
import { forgetConnected } from './connected-sync.ts';
import { parseKey } from './crypto.ts';
import { loadChannels, loadClients, saveChannels, saveClients } from './store.ts';

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

async function workspace(externalId: string, options: { website?: boolean; linkedin?: boolean; urn?: string } = {}): Promise<string> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId, name: externalId } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const brand = String((made.body['workspace'] as { id: string }).id);
  if (options.website !== false) {
    const { file, etag } = await loadClients();
    await saveClients(setWebsite(file, brand, 'acme.com'), etag);
  }
  if (options.linkedin !== false) {
    const { file, etag } = await loadChannels();
    await saveChannels(addLinkedInMember(file, brand, { urn: options.urn ?? 'urn:li:person:abcdefabc', name: 'T' }, 'token', 5_000_000, parseKey(CHANNEL_KEY), Date.now() - 3_600_000), etag);
  }
  return brand;
}

function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.ok(ERROR_CODES.includes(code));
}

const act = { 'x-social-actor': 'user_42' };
const TEXT = 'Diwali special: 20% off all thalis until 2 Nov.';
const ask = (json: Record<string, unknown>, key?: string): Promise<Answer> => call(requestsPost, '/api/v1/topic-requests', { headers: act, ...(key ? { key } : {}), json: { externalId: 'shop-1', text: TEXT, ...json } });
const istMonday = (ahead: number): string => { const d = istDay(ahead); return new Date(Date.parse(`${d}T00:00:00Z`) - ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10); };
const istDay = (ahead: number): string => new Date(Date.now() + 5.5 * 3_600_000 + ahead * 86_400_000).toISOString().slice(0, 10);

test('the day a topic goes out: tomorrow, or the first usable day of the week asked for, and none when that week is over', () => {
  const now = Date.parse('2026-11-18T06:30:00Z');
  assert.equal(topicDay(undefined, now), '2026-11-19');
  assert.equal(topicDay('2026-11-16', now), '2026-11-19', 'this week: its first day she can still use');
  assert.equal(topicDay('2026-11-23', now), '2026-11-23', 'a later week: its Monday');
  assert.equal(topicDay('2026-11-09', now), null, 'a week that is over');
  assert.equal(topicDay('2026-11-16', Date.parse('2026-11-22T10:00:00Z')), null, 'on the Sunday the week has no day left');
});

test('a topic is asked for with her own words: written for her connected channels, the answer says where it stands, and the job behind it is not shown', async () => {
  await withEngine(async (engine) => {
    forgetConnected();
    await workspace('shop-1');
    const made = await ask({});
    assert.equal(made.status, 202, JSON.stringify(made.body));
    const request = made.body['request'] as Record<string, unknown>;
    assert.deepEqual([request['state'], request['picturesToDraw'], request['goesOutOn'], request['goesOutAt']], ['writing', 0, istDay(1), '10:00']);
    assert.match(String(request['id']), /^t-/);
    assert.equal('jobId' in request, false, 'the job id is not part of what a product sees');
    assert.deepEqual(engine.connected, ['linkedin']);
    const sent = engine.seen.find((r) => r.method === 'POST' && r.url === '/review/jobs');
    assert.deepEqual([sent?.body?.['kind'], sent?.body?.['networks'], sent?.body?.['text'], sent?.body?.['startDate']], ['topic', ['linkedin'], TEXT, istDay(1)]);
    const order = engine.seen.filter((r) => r.url === '/review/connected' || r.url === '/review/jobs').map((r) => r.method);
    assert.deepEqual(order, ['PUT', 'POST'], 'the engine is told what is connected before anything is written');
    assert.deepEqual(request['week'], { from: istMonday(1), to: new Date(Date.parse(`${istMonday(1)}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10) }, 'the week is Monday to Sunday');
    const again = await ask({ text: `  ${TEXT.toUpperCase().replace(' ', '   ')}  ` });
    assert.equal(again.status, 200, 'the same words for the same week are the same request');
    assert.equal((again.body['request'] as { id: string }).id, request['id']);
    assert.equal(engine.jobs.filter((j) => j.kind === 'topic').length, 1, 'no second job');
  });
});

test('a week can be asked for: its Monday is the day when it is ahead, a week that is over is refused, and it must be a Monday', async () => {
  await withEngine(async (engine) => {
    await workspace('shop-1');
    const nextMonday = ((): string => { let d = 2; while (new Date(`${istDay(d)}T00:00:00Z`).getUTCDay() !== 1) d += 1; return istDay(d); })();
    const later = await ask({ week: nextMonday });
    assert.equal(later.status, 202, JSON.stringify(later.body));
    assert.equal((later.body['request'] as { goesOutOn: string }).goesOutOn, nextMonday);
    expectError(await ask({ week: '2026-01-05', text: 'Another topic that is long enough.' }), 400, 'DAY_PASSED', 'a week that is over');
    expectError(await ask({ week: '2026-12-02' }), 400, 'INVALID_REQUEST', 'not a Monday');
    expectError(await ask({ week: 'next week' }), 400, 'INVALID_REQUEST', 'not a day');
    assert.equal(engine.jobs.filter((j) => j.kind === 'topic').length, 1);
  });
});

test('words that cannot be used are refused with a code, and one topic a week: the next ask answers with the day she can ask again', async () => {
  await withEngine(async (engine) => {
    await workspace('shop-1');
    expectError(await ask({ text: 'hi' }), 400, 'TEXT_REFUSED', 'too short');
    assert.equal((await ask({ text: 'hi' })).body['reason'], 'TOO_SHORT');
    expectError(await ask({ text: 'x'.repeat(1001) }), 400, 'TEXT_REFUSED', 'too long');
    expectError(await ask({ text: 'See https://acme.example/diwali for the offer' }), 400, 'LINK_NOT_ALLOWED', 'a link');
    for (const text of ['See www.example.com for our new menu', 'Our new menu is on brandbasket.in starting today', 'Write to hello@example.com for the offer']) expectError(await ask({ text }), 400, 'LINK_NOT_ALLOWED', text);
    const best = await ask({ text: 'The best thali in town, 20% off all week' });
    expectError(best, 400, 'TEXT_REFUSED', 'a claim that needs proof');
    assert.equal(best.body['reason'], 'NEEDS_PROOF');
    expectError(await call(requestsPost, '/api/v1/topic-requests', { headers: act, json: { externalId: 'shop-1', text: 42 } }), 400, 'TEXT_REFUSED', 'not text');
    assert.equal(engine.jobs.length, 0, 'nothing refused starts a job');
    engine.topicRefusal = { restart: '2026-11-23', error: 'You have already added a topic for the week of 2026-11-16. You can add another from 2026-11-23.' };
    const full = await ask({ text: 'New dish: paneer kulcha, from Monday.' });
    expectError(full, 429, 'TOPIC_LIMIT_REACHED', 'the week has its topic');
    assert.equal(full.body['restart'], '2026-11-23');
    assert.match(String(full.body['error']), /2026-11-23/);
  });
});

test('a topic needs a read website, a connected channel and a brand that is not put away; another product never reaches it', async () => {
  await withEngine(async () => {
    await workspace('shop-1', { website: false });
    expectError(await ask({}), 409, 'CONFLICT', 'no website yet');
    expectError(await call(requestsPost, '/api/v1/topic-requests', { headers: act, json: { externalId: 'nobody', text: TEXT } }), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
    expectError(await call(requestsPost, '/api/v1/topic-requests', { headers: act, json: 'not an object' }), 400, 'INVALID_REQUEST', 'not an object');
    expectError(await call(requestsPost, '/api/v1/topic-requests', { headers: { ...act, 'content-length': '20000' }, json: { externalId: 'shop-1', text: TEXT } }), 413, 'REQUEST_TOO_LARGE', 'too large');
    expectError(await ask({}, OTHER_KEY), 404, 'WORKSPACE_NOT_FOUND', 'another product');
    const { file, etag } = await loadClients();
    await saveClients(setWebsite(file, String((file.clients[0] as { brand: string }).brand), 'acme.com'), etag);
    const { file: channels, etag: channelEtag } = await loadChannels();
    await saveChannels({ ...channels, channels: [] } as never, channelEtag);
    expectError(await ask({}), 400, 'CHANNEL_NOT_CONNECTED', 'nothing connected');
    await workspace('shop-2');
    const archived = await call(archivePost, '/api/v1/workspaces/archive', { json: { externalId: 'shop-2', archived: true } });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    expectError(await call(requestsPost, '/api/v1/topic-requests', { headers: act, json: { externalId: 'shop-2', text: TEXT } }), 409, 'WORKSPACE_ARCHIVED', 'put away');
  });
});

test('the list shows what she asked and what came of it, newest first; one request can be read by its id', async () => {
  await withEngine(async (engine) => {
    await workspace('shop-1');
    const first = (await ask({})).body['request'] as { id: string };
    engine.topics[0] = { ...engine.topics[0], state: 'waiting_for_words', batchId: 'week-02.json', postId: 'w02-d1', picturesToDraw: 1, words: { headline: 'Diwali thalis, 20% off', captions: { linkedin: 'For LinkedIn.' } } };
    const list = await call(requestsGet, '/api/v1/topic-requests?externalId=shop-1');
    assert.equal(list.status, 200);
    const rows = list.body['requests'] as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => r['id']), [first.id]);
    assert.deepEqual([rows[0]?.['state'], rows[0]?.['batchId'], rows[0]?.['postId'], rows[0]?.['picturesToDraw'], rows[0]?.['words']], ['waiting_for_words', 'week-02.json', 'w02-d1', 1, { headline: 'Diwali thalis, 20% off', captions: { linkedin: 'For LinkedIn.' } }]);
    assert.equal('jobId' in (rows[0] as object), false);
    const one = await call(requestsGet, `/api/v1/topic-requests?externalId=shop-1&id=${first.id}`);
    assert.equal((one.body['request'] as { id: string }).id, first.id);
    expectError(await call(requestsGet, '/api/v1/topic-requests?externalId=shop-1&id=t-nope'), 404, 'NOT_FOUND', 'no such request');
    expectError(await call(requestsGet, '/api/v1/topic-requests?externalId=shop-1&id=../x'), 400, 'INVALID_REQUEST', 'not an id');
    expectError(await call(requestsGet, '/api/v1/topic-requests?externalId=nobody'), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
    engine.topics.unshift({ ...engine.topics[0], id: 't-zz-abcdef', state: 'not_made', reason: 'NO_PICTURE_ROOM', jobId: 'job-zzzzz-0123abcd' });
    const second = (await call(requestsGet, '/api/v1/topic-requests?externalId=shop-1')).body['requests'] as Array<Record<string, unknown>>;
    assert.deepEqual(second.map((r) => [r['id'], r['reason']]), [['t-zz-abcdef', 'NO_PICTURE_ROOM'], [first.id, undefined]]);
  });
});

test('one topic a week is enforced per customer, and another customer\'s request is never found by its id', async () => {
  await withEngine(async () => {
    await workspace('shop-1');
    await workspace('shop-2', { urn: 'urn:li:person:zzzzzzzzz' });
    const first = (await ask({})).body['request'] as { id: string };
    const full = await ask({ text: 'New dish: paneer kulcha, served from Monday.' });
    expectError(full, 429, 'TOPIC_LIMIT_REACHED', 'a second topic in the week');
    assert.match(String(full.body['restart']), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(`${String(full.body['restart'])}T00:00:00Z`).getUTCDay(), 1, 'she can ask again on a Monday');
    const other = await call(requestsPost, '/api/v1/topic-requests', { headers: act, json: { externalId: 'shop-2', text: 'New dish: paneer kulcha, served from Monday.' } });
    assert.equal(other.status, 202, 'another customer has her own week');
    expectError(await call(requestsGet, `/api/v1/topic-requests?externalId=shop-2&id=${first.id}`), 404, 'NOT_FOUND', 'the other customer\'s request');
    const list = (await call(requestsGet, '/api/v1/topic-requests?externalId=shop-2')).body['requests'] as Array<{ id: string }>;
    assert.equal(list.length, 1);
    assert.notEqual(list[0]?.id, first.id);
  });
});

test('saved posting days never move a topic: it goes out on tomorrow with no weekdays sent to the engine', async () => {
  await withEngine(async (engine) => {
    forgetConnected();
    const brand = await workspace('shop-1');
    const { file, etag } = await loadClients();
    const { setPostingDays } = await import('./posting-days.ts');
    await saveClients(setPostingDays(file, brand, { linkedin: ['sat'] }), etag);
    const made = await ask({});
    assert.equal(made.status, 202, JSON.stringify(made.body));
    assert.equal((made.body['request'] as Record<string, unknown>)['goesOutOn'], istDay(1), 'tomorrow, whatever her days are');
    const sent = engine.seen.find((r) => r.method === 'POST' && r.url === '/review/jobs');
    assert.equal(sent?.body?.['weekdays'], undefined);
    assert.equal(sent?.body?.['startDate'], istDay(1));
  });
});
