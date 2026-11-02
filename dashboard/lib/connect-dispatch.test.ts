import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GET, POST } from '../api/connect.ts';

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
