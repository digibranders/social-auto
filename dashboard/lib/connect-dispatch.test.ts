import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET, POST } from '../api/connect.ts';
import { createSession } from './security.ts';
import { verifyInvite } from './linkedin-flow.ts';

const call = (path: string, init?: RequestInit): Request => new Request(`http://localhost:4010${path}`, init);

test('each connect address reaches its own handler, by the address called or by the rewrite\'s step', async () => {
  delete process.env['LINKEDIN_CLIENT_ID'];
  delete process.env['FACEBOOK_APP_ID'];
  delete process.env['INSTAGRAM_APP_ID'];
  assert.equal((await GET(call('/api/linkedin-start'))).status, 503);
  assert.equal((await GET(call('/api/connect?step=linkedin-start'))).status, 503);
  assert.equal(await (await GET(call('/api/facebook-start'))).text(), 'Facebook is not configured');
  assert.equal(await (await GET(call('/api/connect?step=instagram-start'))).text(), 'Instagram is not configured');
});

test('the callbacks are reached too, and a callback with no saved state is turned away', async () => {
  for (const step of ['facebook-callback', 'instagram-callback', 'linkedin-callback']) {
    const response = await GET(call(`/api/connect?step=${step}&code=x&state=y`));
    assert.notEqual(response.status, 404, step);
  }
});

test('the invite is POST only, and an unknown step is a 404', async () => {
  assert.equal((await POST(call('/api/linkedin-invite?brand=x', { method: 'POST' }))).status, 401);
  assert.equal((await GET(call('/api/linkedin-invite'))).status, 404);
  assert.equal((await GET(call('/api/connect'))).status, 404);
  assert.equal((await GET(call('/api/connect?step=nope'))).status, 404);
  assert.equal((await POST(call('/api/connect?step=facebook-start', { method: 'POST' }))).status, 404);
});

test('a signed-in person can make a Facebook link that the Facebook start page accepts', async () => {
  const secret = 'a-long-test-secret-a-long-test-secret';
  Object.assign(process.env, { SESSION_SECRET: secret, FACEBOOK_APP_ID: 'app-1', FACEBOOK_CONFIG_ID: 'cfg-1' });
  const headers = { cookie: `cal_session=${createSession(secret, Date.now())}`, origin: 'http://localhost:4010', host: 'localhost:4010' };
  const made = await POST(call('/api/linkedin-invite?brand=acme-dental&channel=facebook', { method: 'POST', headers }));
  assert.equal(made.status, 200);
  const { link } = (await made.json()) as { link: string };
  const url = new URL(link);
  assert.equal(url.pathname, '/api/facebook-start');
  assert.equal(verifyInvite(url.searchParams.get('invite'), secret, Date.now())?.brand, 'acme-dental');

  // Opening it needs no sign-in and goes to Facebook; a tampered link is refused.
  const start = await GET(call(`${url.pathname}${url.search}`));
  assert.equal(start.status, 302);
  assert.match(start.headers.get('location') ?? '', /facebook\.com\/.*client_id=app-1.*config_id=cfg-1/);
  assert.match(start.headers.get('set-cookie') ?? '', /^fb_connect=[0-9a-f]{32}\.acme-dental/);
  assert.equal((await GET(call(`${url.pathname}?invite=${url.searchParams.get('invite')}x`))).status, 410);

  delete process.env['FACEBOOK_APP_ID'];
  assert.equal((await POST(call('/api/linkedin-invite?brand=acme-dental&channel=facebook', { method: 'POST', headers }))).status, 503);
});
