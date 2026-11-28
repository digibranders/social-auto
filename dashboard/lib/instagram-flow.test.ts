import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConnectCookie } from './facebook-flow.ts';
import { authorizeLink, callbackUrl, clearedConnectCookie, connectCookie, facebookLoginLink, INSTAGRAM_COOKIE, usesFacebookLogin } from './instagram-flow.ts';

test('the link asks to read the profile, publish posts, and manage comments/messages, and names the way back', () => {
  const link = new URL(authorizeLink({ appId: '123', redirectUri: 'https://cal.example/api/instagram-callback', state: 's' }));
  assert.equal(link.origin + link.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(link.searchParams.get('client_id'), '123');
  assert.equal(link.searchParams.get('response_type'), 'code');
  assert.equal(
    link.searchParams.get('scope'),
    'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages,instagram_business_manage_comments',
  );
  assert.equal(link.searchParams.get('state'), 's');
  assert.equal(link.searchParams.get('redirect_uri'), 'https://cal.example/api/instagram-callback');
});

test('the cookie has its own name, round-trips the state, client and return address, and clears itself', () => {
  const state = 'a'.repeat(32);
  const cookie = connectCookie(state, 'brandbasket', 'https://app.brandbasket.in/social', true);
  assert.ok(cookie.startsWith(`${INSTAGRAM_COOKIE}=`));
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Path=\/api/);
  const value = cookie.split(';')[0]!.split('=')[1];
  assert.deepEqual(parseConnectCookie(value), { state, brand: 'brandbasket', returnUrl: 'https://app.brandbasket.in/social' });
  assert.match(clearedConnectCookie(true), new RegExp(`^${INSTAGRAM_COOKIE}=; .*Max-Age=0`));
});

test('the way back follows the address the request came to, also behind a proxy', () => {
  assert.equal(callbackUrl(new Request('http://localhost:4010/x', { headers: { host: 'localhost:4010' } })), 'http://localhost:4010/api/instagram-callback');
  assert.equal(
    callbackUrl(new Request('http://internal/x', { headers: { 'x-forwarded-host': 'cal.example', 'x-forwarded-proto': 'https' } })),
    'https://cal.example/api/instagram-callback',
  );
});

test('Facebook login names the saved configuration, passes no scope, and returns to the same callback', () => {
  const link = new URL(facebookLoginLink({ appId: '111', configId: '222', redirectUri: 'https://cal.example/api/instagram-callback', state: 's' }));
  assert.equal(link.origin + link.pathname, 'https://www.facebook.com/dialog/oauth');
  assert.equal(link.searchParams.get('client_id'), '111');
  assert.equal(link.searchParams.get('config_id'), '222');
  assert.equal(link.searchParams.get('response_type'), 'code');
  assert.equal(link.searchParams.get('state'), 's');
  assert.equal(link.searchParams.get('redirect_uri'), 'https://cal.example/api/instagram-callback');
  assert.equal(link.searchParams.has('scope'), false);
});

test('Facebook login is used only when INSTAGRAM_LOGIN says so', () => {
  const before = process.env['INSTAGRAM_LOGIN'];
  try {
    delete process.env['INSTAGRAM_LOGIN'];
    assert.equal(usesFacebookLogin(), false);
    process.env['INSTAGRAM_LOGIN'] = 'facebook';
    assert.equal(usesFacebookLogin(), true);
  } finally {
    if (before === undefined) delete process.env['INSTAGRAM_LOGIN'];
    else process.env['INSTAGRAM_LOGIN'] = before;
  }
});
