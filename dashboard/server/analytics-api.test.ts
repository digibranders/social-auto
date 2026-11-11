import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { GET as analytics } from '../api/analytics.ts';
import { createSession, SESSION_COOKIE } from '../lib/security.ts';

const originalFetch = globalThis.fetch;
let asked: string[] = [];
let authorization: string | null = null;

beforeEach(() => {
  process.env['SESSION_SECRET'] = 'session-secret';
  process.env['STATUS_URL'] = 'http://127.0.0.1:4021/api/status';
  process.env['STATUS_SECRET'] = 'status-secret-0123456789';
  asked = [];
  authorization = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push(String(input));
    authorization = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify({ enabled: true, posts: [], accounts: [], hashtags: [], checkedAt: null, secret: 'leak' }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const request = (query: string, signedIn = true): Request => new Request(`https://dash.example/api/analytics?${query}`, { headers: signedIn ? { cookie: `${SESSION_COOKIE}=${createSession('session-secret', Date.now())}` } : {} });

test('a signed-in person gets a client\'s numbers through the server, which adds the secret and passes only the three allowed questions', async () => {
  const answer = await analytics(request('brand=acme&from=2026-11-01&to=2026-11-12&evil=1'));
  assert.equal(answer.status, 200);
  assert.deepEqual(asked, ['http://127.0.0.1:4021/api/analytics?brand=acme&from=2026-11-01&to=2026-11-12']);
  assert.equal(authorization, 'Bearer status-secret-0123456789');
  const body = (await answer.json()) as Record<string, unknown>;
  assert.equal('secret' in body, false, 'only what the dashboard understands is passed on');
  assert.equal(body['enabled'], true);
});

test('nobody who is not signed in gets anything, and nothing is asked of the publisher', async () => {
  assert.equal((await analytics(request('brand=acme', false))).status, 401);
  assert.deepEqual(asked, []);
});

test('a bad question from the publisher is shown as it is and a failing publisher as a bad gateway', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'from must be a date like 2026-11-30' }), { status: 400 })) as typeof fetch;
  const bad = await analytics(request('brand=acme&from=nope'));
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /must be a date/);
  globalThis.fetch = (async () => new Response('x', { status: 500 })) as typeof fetch;
  assert.equal((await analytics(request('brand=acme'))).status, 502);
});
