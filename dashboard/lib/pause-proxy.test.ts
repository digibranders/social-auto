import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST as pause } from '../api/pause.ts';
import { POST as edit } from '../api/edit.ts';
import { createSession } from './security.ts';

const SECRET = 'a-long-test-secret-a-long-test-secret';
const headers = { cookie: `cal_session=${createSession(SECRET, Date.now())}`, origin: 'http://localhost:4010', host: 'localhost:4010', 'content-type': 'application/json' };
const call = (path: string, init: RequestInit): Request => new Request(`http://localhost:4010${path}`, init);

function setup(): { sent: Array<{ url: string; body: string | null; auth: string | null }>; restore: () => void } {
  Object.assign(process.env, { SESSION_SECRET: SECRET, EDIT_URL: 'http://127.0.0.1:4021', EDIT_SECRET: 'publisher-secret' });
  const sent: Array<{ url: string; body: string | null; auth: string | null }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: URL | string, init?: RequestInit) => {
    sent.push({ url: String(url), body: typeof init?.body === 'string' ? init.body : null, auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => void (globalThis.fetch = real) };
}

test('pausing is for signed-in people from this site only, and the request is checked before it goes anywhere', async () => {
  const { sent, restore } = setup();
  try {
    const body = JSON.stringify({ scope: 'brand', id: 'acme', paused: true });
    assert.equal((await pause(call('/api/pause', { method: 'POST', body, headers: { 'content-type': 'application/json' } }))).status, 401);
    assert.equal((await pause(call('/api/pause', { method: 'POST', body, headers: { ...headers, origin: 'https://evil.example' } }))).status, 403);
    for (const bad of [{ scope: 'nope', paused: true }, { scope: 'brand', paused: true }, { scope: 'brand', id: '../x y', paused: true }, { scope: 'all', paused: 'yes' }]) {
      assert.equal((await pause(call('/api/pause', { method: 'POST', body: JSON.stringify(bad), headers }))).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(sent, []);
  } finally {
    restore();
  }
});

test('a pause is passed to the publisher with its own secret, at the publisher\'s pause address', async () => {
  const { sent, restore } = setup();
  try {
    assert.equal((await pause(call('/api/pause', { method: 'POST', body: JSON.stringify({ scope: 'channel', id: 'facebook:77', paused: true }), headers }))).status, 200);
    assert.equal((await pause(call('/api/pause', { method: 'POST', body: JSON.stringify({ scope: 'all', id: 'ignored', paused: false }), headers }))).status, 200);
    assert.deepEqual(sent.map((s) => [s.url, s.auth, s.body]), [
      ['http://127.0.0.1:4021/api/pause', 'Bearer publisher-secret', JSON.stringify({ scope: 'channel', id: 'facebook:77', paused: true })],
      ['http://127.0.0.1:4021/api/pause', 'Bearer publisher-secret', JSON.stringify({ scope: 'all', paused: false })],
    ]);
  } finally {
    restore();
  }
});

test('skipping and unskipping a post go through the edit address, which is found whether EDIT_URL is a bare address or not', async () => {
  const { sent, restore } = setup();
  try {
    for (const action of ['skip', 'unskip']) assert.equal((await edit(call(`/api/edit?post=manual-0123456789ab&action=${action}`, { method: 'POST', headers }))).status, 200);
    assert.deepEqual(sent.map((s) => s.url), ['http://127.0.0.1:4021/api/edit?post=manual-0123456789ab&action=skip', 'http://127.0.0.1:4021/api/edit?post=manual-0123456789ab&action=unskip']);
    process.env['EDIT_URL'] = 'http://127.0.0.1:4021/api/edit';
    await edit(call('/api/edit?post=p1&action=skip', { method: 'POST', headers }));
    assert.equal(sent[2]?.url, 'http://127.0.0.1:4021/api/edit?post=p1&action=skip');
  } finally {
    restore();
  }
});
