import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeLink, callbackUrl, connectCookie, isBrand, newState, parseConnectCookie, statesMatch } from './facebook-flow.ts';

test('state is random hex, and the cookie round-trips state and client', () => {
  const state = newState();
  assert.match(state, /^[0-9a-f]{32}$/);
  assert.notEqual(state, newState());
  const cookie = connectCookie(state, 'brandbasket', null, true);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  const value = cookie.split(';')[0]!.split('=')[1];
  assert.deepEqual(parseConnectCookie(value), { state, brand: 'brandbasket', returnUrl: null });
});

test('malformed cookies and client names are rejected', () => {
  assert.equal(parseConnectCookie(undefined), null);
  assert.equal(parseConnectCookie('short.brand'), null);
  assert.equal(parseConnectCookie(`${'a'.repeat(32)}.Bad Brand`), null);
  assert.equal(isBrand('brandbasket'), true);
  assert.equal(isBrand('../x'), false);
  assert.equal(isBrand(null), false);
});

test('statesMatch is exact', () => {
  assert.equal(statesMatch('abc', 'abc'), true);
  assert.equal(statesMatch('abd', 'abc'), false);
  assert.equal(statesMatch(null, 'abc'), false);
  assert.equal(statesMatch('abcd', 'abc'), false);
});

test('callbackUrl follows the address the request came to, including behind a proxy', () => {
  assert.equal(callbackUrl(new Request('http://localhost:4010/api/facebook-start', { headers: { host: 'localhost:4010' } })), 'http://localhost:4010/api/facebook-callback');
  assert.equal(
    callbackUrl(new Request('http://internal/api/x', { headers: { 'x-forwarded-host': 'cal.example', 'x-forwarded-proto': 'https' } })),
    'https://cal.example/api/facebook-callback',
  );
});

test('authorizeLink uses a configuration when there is one, scopes otherwise', () => {
  const plain = new URL(authorizeLink({ appId: '1', redirectUri: 'https://x/cb', state: 's' }));
  assert.equal(plain.searchParams.get('scope'), 'pages_show_list,pages_manage_posts,pages_read_engagement');
  const business = new URL(authorizeLink({ appId: '1', redirectUri: 'https://x/cb', state: 's', configId: '9' }));
  assert.equal(business.searchParams.get('config_id'), '9');
  assert.equal(business.searchParams.get('scope'), null);
  assert.equal(business.searchParams.get('redirect_uri'), 'https://x/cb');
});

test('the cookie carries the address to return to, and refuses an unsafe one', () => {
  const state = newState();
  const back = 'https://app.brandbasket.in/social';
  const value = connectCookie(state, 'brandbasket', back, true).split(';')[0]!.split('=')[1];
  assert.deepEqual(parseConnectCookie(value), { state, brand: 'brandbasket', returnUrl: back });
  const unsafe = `${state}.brandbasket.${Buffer.from('javascript:alert(1)').toString('base64url')}`;
  assert.equal(parseConnectCookie(unsafe), null);
});
