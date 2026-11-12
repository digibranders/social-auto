import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { POST as refresh } from '../api/analytics-refresh.ts';
import { createSession, SESSION_COOKIE } from '../lib/security.ts';

const originalFetch = globalThis.fetch;
type Call = { url: string; method: string; auth: string | null; body: string };
let asked: Call[] = [];
const firstCall = (): Call | undefined => asked[0];

beforeEach(() => {
  process.env['SESSION_SECRET'] = 'session-secret';
  process.env['EDIT_URL'] = 'http://127.0.0.1:4021';
  process.env['EDIT_SECRET'] = 'edit-secret-0123456789';
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ posts: 3, accounts: 1, failed: 0 }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

const cookie = `${SESSION_COOKIE}=${createSession('session-secret', Date.now())}`;
const post = (body: unknown, opts: { signedIn?: boolean; origin?: boolean } = {}): Request => new Request('https://dash.example/api/analytics-refresh', { method: 'POST', headers: { 'content-type': 'application/json', host: 'dash.example', ...(opts.origin === false ? {} : { origin: 'https://dash.example' }), ...(opts.signedIn === false ? {} : { cookie }) }, body: JSON.stringify(body) });

test('a refresh needs a signed-in person from this site and a client, and reaches the publisher with the write secret', async () => {
  assert.equal((await refresh(post({ brand: 'acme' }, { signedIn: false }))).status, 401);
  assert.equal((await refresh(post({ brand: 'acme' }, { origin: false }))).status, 403);
  for (const bad of [{}, { brand: '' }, { brand: 'a b' }, { brand: 5 }]) assert.equal((await refresh(post(bad))).status, 400, JSON.stringify(bad));
  assert.deepEqual(asked, [], 'nothing reached the publisher');
  const ok = await refresh(post({ brand: 'acme', extra: 'ignored' }));
  assert.equal(ok.status, 200);
  assert.deepEqual([firstCall()?.url, firstCall()?.method, firstCall()?.auth, JSON.parse(firstCall()?.body ?? '{}')], ['http://127.0.0.1:4021/api/analytics-refresh', 'POST', 'Bearer edit-secret-0123456789', { brand: 'acme' }]);
});

test('what the publisher says about a refusal is shown, and an unexpected failure is a bad gateway', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'analytics is switched off' }), { status: 503 })) as typeof fetch;
  const off = await refresh(post({ brand: 'acme' }));
  assert.equal(off.status, 503);
  assert.match(((await off.json()) as { error: string }).error, /switched off/);
  globalThis.fetch = (async () => new Response('x', { status: 500 })) as typeof fetch;
  assert.equal((await refresh(post({ brand: 'acme' }))).status, 502);
});
