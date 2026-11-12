import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { GET as inboxGet, POST as inboxPost } from '../api/inbox.ts';
import { createSession, SESSION_COOKIE } from '../lib/security.ts';

const originalFetch = globalThis.fetch;
type Call = { url: string; method: string; auth: string | null; body: string };
let asked: Call[] = [];
const firstCall = (): Call | undefined => asked[0];

beforeEach(() => {
  process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
  process.env['SESSION_SECRET'] = 'session-secret';
  process.env['STATUS_URL'] = 'http://127.0.0.1:4021/api/status';
  process.env['STATUS_SECRET'] = 'status-secret-0123456789';
  process.env['EDIT_URL'] = 'http://127.0.0.1:4021';
  process.env['EDIT_SECRET'] = 'edit-secret-0123456789';
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ enabled: true, items: [], channels: [], counts: { todo: 0, done: 0, unread: 0 }, checkedAt: null, secret: 'leak', ok: true }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; delete process.env['SOCIAL_PUBLISHING_ENABLED']; });

const cookie = `${SESSION_COOKIE}=${createSession('session-secret', Date.now())}`;
const get = (query: string, signedIn = true): Request => new Request(`https://dash.example/api/inbox?${query}`, { headers: signedIn ? { cookie } : {} });
const post = (body: unknown, opts: { signedIn?: boolean; origin?: boolean } = {}): Request => new Request('https://dash.example/api/inbox', { method: 'POST', headers: { 'content-type': 'application/json', host: 'dash.example', ...(opts.origin === false ? {} : { origin: 'https://dash.example' }), ...(opts.signedIn === false ? {} : { cookie }) }, body: JSON.stringify(body) });

test('a signed-in person reads a client\'s inbox through the server, which adds the read secret and passes only the allowed questions', async () => {
  const answer = await inboxGet(get('brand=acme&status=todo&evil=1'));
  assert.equal(answer.status, 200);
  assert.deepEqual([firstCall()?.url, firstCall()?.auth], ['http://127.0.0.1:4021/api/inbox?brand=acme&status=todo', 'Bearer status-secret-0123456789']);
  assert.equal('secret' in ((await answer.json()) as object), false);
  assert.equal((await inboxGet(get('brand=acme', false))).status, 401);
});

test('a write needs a signed-in person from this site, checks its parts, and reaches the publisher with the write secret', async () => {
  assert.equal((await inboxPost(post({ id: 'instagram:1|c1', action: 'done', by: 'Asha' }, { signedIn: false }))).status, 401);
  assert.equal((await inboxPost(post({ id: 'instagram:1|c1', action: 'done', by: 'Asha' }, { origin: false }))).status, 403);
  for (const bad of [{ action: 'done', by: 'A' }, { id: 'x y', action: 'done', by: 'A' }, { id: 'a', action: 'delete', by: 'A' }, { id: 'a', action: 'done', by: '' }, { id: 'a', action: 'reply', by: 'A', text: 5 }]) {
    assert.equal((await inboxPost(post(bad))).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(asked, [], 'nothing reached the publisher');
  const ok = await inboxPost(post({ id: 'instagram:1|c1', action: 'reply', text: 'Yes!', by: ' Asha ', extra: 'ignored' }));
  assert.equal(ok.status, 200);
  assert.deepEqual([firstCall()?.url, firstCall()?.method, firstCall()?.auth, JSON.parse(firstCall()?.body ?? '{}')], ['http://127.0.0.1:4021/api/inbox', 'POST', 'Bearer edit-secret-0123456789', { id: 'instagram:1|c1', action: 'reply', by: 'Asha', text: 'Yes!' }]);
});

test('what the publisher says about a refused change is shown, and an unexpected failure is a bad gateway', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'This account has not given permission to reply.' }), { status: 409 })) as typeof fetch;
  const refused = await inboxPost(post({ id: 'a', action: 'reply', text: 'Hi', by: 'A' }));
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /permission/);
  globalThis.fetch = (async () => new Response('x', { status: 500 })) as typeof fetch;
  assert.equal((await inboxPost(post({ id: 'a', action: 'done', by: 'A' }))).status, 502);
});

test('while publishing is switched off a public reply is refused and nothing is passed on, but closing, assigning and noting still work', async () => {
  delete process.env['SOCIAL_PUBLISHING_ENABLED'];
  const refused = await inboxPost(post({ id: 'instagram:1|c1', action: 'reply', text: 'Hi', by: 'A' }));
  assert.equal(refused.status, 503);
  assert.match(((await refused.json()) as { error: string }).error, /switched off/);
  assert.deepEqual(asked, []);
  for (const action of ['done', 'reopen', 'read'] as const) assert.equal((await inboxPost(post({ id: 'instagram:1|c1', action, by: 'A' }))).status, 200, action);
  assert.equal((await inboxPost(post({ id: 'instagram:1|c1', action: 'note', text: 'x', by: 'A' }))).status, 200);
  assert.equal(asked.length, 4);
});
