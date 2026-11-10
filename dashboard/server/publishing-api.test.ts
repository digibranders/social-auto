import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createSession, SESSION_COOKIE } from '../lib/security.ts';
import { POST as manual } from '../api/manual.ts';
import { POST as edit } from '../api/edit.ts';

const originalFetch = globalThis.fetch;
const originalSwitch = process.env['SOCIAL_PUBLISHING_ENABLED'];
let calls = 0;

beforeEach(() => {
  process.env['SESSION_SECRET'] = 'session-secret';
  process.env['EDIT_URL'] = 'http://127.0.0.1:4013/edit';
  process.env['EDIT_SECRET'] = 'edit-secret-0123456789';
  delete process.env['SOCIAL_PUBLISHING_ENABLED'];
  calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSwitch === undefined) delete process.env['SOCIAL_PUBLISHING_ENABLED'];
  else process.env['SOCIAL_PUBLISHING_ENABLED'] = originalSwitch;
});

const request = (path: string, body: unknown = {}): Request => new Request(`https://dash.example${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: 'dash.example', origin: 'https://dash.example', cookie: `${SESSION_COOKIE}=${createSession('session-secret', Date.now())}` },
  body: JSON.stringify(body),
});

test('while publishing is off, hand-made posts cannot be created and nothing is passed on', async () => {
  for (const action of ['image', 'create']) assert.equal((await manual(request(`/api/manual?action=${action}`, { brand: 'acme' }))).status, 503, action);
  assert.equal(calls, 0);
  const answer = (await (await manual(request('/api/manual?action=create'))).json()) as { error: string };
  assert.match(answer.error, /switched off/);
});

test('while publishing is off, a post\'s caption and picture cannot be changed', async () => {
  for (const action of ['caption', 'image', 'revert']) assert.equal((await edit(request(`/api/edit?post=manual-0123456789ab&action=${action}`, { caption: 'x' }))).status, 503, action);
  assert.equal(calls, 0);
});

test('while publishing is off, skipping a post is still allowed, and putting it back is not', async () => {
  assert.equal((await edit(request('/api/edit?post=manual-0123456789ab&action=skip'))).status, 200);
  assert.equal((await edit(request('/api/edit?post=manual-0123456789ab&action=unskip'))).status, 503);
});

test('taking a hand-made post away is still allowed', async () => {
  assert.equal((await manual(request('/api/manual?action=delete&post=manual-0123456789ab'))).status, 200);
  assert.equal(calls, 1);
});

test('look-alike values do not open the switch, and a request cannot open it either', async () => {
  for (const value of ['TRUE', '1', 'yes', 'false', '']) {
    process.env['SOCIAL_PUBLISHING_ENABLED'] = value;
    assert.equal((await manual(request('/api/manual?action=create&SOCIAL_PUBLISHING_ENABLED=true', { SOCIAL_PUBLISHING_ENABLED: 'true', publishingEnabled: true }))).status, 503, value);
  }
  assert.equal(calls, 0);
});

test('with the switch on, the requests go on to the publisher as before', async () => {
  process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';
  assert.equal((await manual(request('/api/manual?action=create', { brand: 'acme' }))).status, 200);
  assert.equal((await edit(request('/api/edit?post=manual-0123456789ab&action=revert'))).status, 200);
  assert.equal(calls, 2);
});
