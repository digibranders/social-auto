import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishConnect } from './connect-result.ts';

const request = new Request('http://localhost:4010/api/facebook-callback');

test('a person sent by a product goes back to it, and expiry is reported as a failure', () => {
  const response = finishConnect({ request, platform: 'facebook', outcome: 'expired', clearCookie: 'c=; Max-Age=0', returnUrl: 'http://localhost:3198/social' });
  assert.equal(response.status, 302);
  const back = new URL(response.headers.get('location') as string);
  assert.equal(back.origin + back.pathname, 'http://localhost:3198/social');
  assert.equal(back.searchParams.get('social'), 'failed');
  assert.equal(back.searchParams.get('channel'), 'facebook');
  assert.equal(response.headers.get('set-cookie'), 'c=; Max-Age=0');
});

test('a person with no login and no return address sees a plain page naming the platform', async () => {
  const done = finishConnect({ request, platform: 'facebook', outcome: 'connected', clearCookie: 'c=' });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Your Facebook is now linked/);
  const lost = finishConnect({ request, platform: 'linkedin', outcome: 'failed', clearCookie: 'c=' });
  assert.equal(lost.status, 400);
});

test('a client connecting Google sees its own wording, and a missing listing explains what to do', async () => {
  const done = finishConnect({ request, platform: 'google', outcome: 'connected', clearCookie: 'c=' });
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Your Google Business listing is now linked/);
  const none = finishConnect({ request, platform: 'google', outcome: 'nolocation', clearCookie: 'c=' });
  assert.equal(none.status, 400);
  assert.match(await none.text(), /does not manage a business listing/);
});

test('a product is told why a connection failed, and more than one cookie can be set', () => {
  const expired = finishConnect({ request, platform: 'google', outcome: 'expired', clearCookie: 'a=; Max-Age=0', extraCookies: ['b=1'], returnUrl: 'http://localhost:3198/social' });
  assert.equal(new URL(expired.headers.get('location') as string).searchParams.get('reason'), 'EXPIRED');
  assert.deepEqual(expired.headers.getSetCookie(), ['a=; Max-Age=0', 'b=1']);
  const none = finishConnect({ request, platform: 'google', outcome: 'nolocation', clearCookie: 'a=', returnUrl: 'http://localhost:3198/social' });
  assert.equal(new URL(none.headers.get('location') as string).searchParams.get('reason'), 'NO_LOCATION');
  const fine = finishConnect({ request, platform: 'google', outcome: 'connected', clearCookie: 'a=', returnUrl: 'http://localhost:3198/social' });
  assert.equal(new URL(fine.headers.get('location') as string).searchParams.has('reason'), false);
});
