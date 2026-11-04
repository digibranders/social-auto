import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizeLink, callbackUrl, connectCookie, parseConnectCookie, parsePickCookie, pickCookie } from './google-flow.ts';

const SEALED = 'v1.AbC_-123.dEf_-456.gHi_-789';

test('the state cookie round-trips and rejects malformed values', () => {
  const state = 'a'.repeat(32);
  const cookie = connectCookie(state, 'brandbasket', null, true);
  assert.match(cookie, /^g_connect=.*HttpOnly; Secure; SameSite=Lax; Path=\/api/);
  assert.deepEqual(parseConnectCookie(cookie.split(';')[0]!.split('=')[1]), { state, brand: 'brandbasket', returnUrl: null });
  assert.equal(parseConnectCookie('short.brand'), null);
  assert.equal(parseConnectCookie(undefined), null);
});

test('the waiting-choice cookie carries the client and sealed token, hidden from scripts', () => {
  const cookie = pickCookie('brandbasket', SEALED, null, true);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax; Path=\/api; Max-Age=900/);
  const value = cookie.split(';')[0]!.slice('g_pick='.length);
  assert.deepEqual(parsePickCookie(value), { brand: 'brandbasket', sealed: SEALED, returnUrl: null });
});

test('a waiting-choice cookie that is not exactly client~sealed is refused', () => {
  assert.equal(parsePickCookie(undefined), null);
  assert.equal(parsePickCookie('brandbasket'), null);
  assert.equal(parsePickCookie(`brandbasket~${SEALED}~extra~more`), null);
  assert.equal(parsePickCookie(`Bad Brand~${SEALED}`), null);
  assert.equal(parsePickCookie('brandbasket~not-sealed'), null);
  assert.throws(() => pickCookie('brandbasket', 'junk'), /not a valid/);
  assert.throws(() => pickCookie('../x', SEALED), /not a valid/);
});

test('the Google link asks for offline posting access and returns to this site', () => {
  const link = new URL(authorizeLink({ clientId: 'cid', redirectUri: 'https://x/api/google/callback', state: 's' }));
  assert.equal(link.searchParams.get('scope'), 'https://www.googleapis.com/auth/business.manage');
  assert.equal(link.searchParams.get('access_type'), 'offline');
  assert.equal(link.searchParams.get('prompt'), 'consent');
  assert.equal(link.searchParams.get('redirect_uri'), 'https://x/api/google/callback');
  assert.equal(
    callbackUrl(new Request('http://internal/api/x', { headers: { 'x-forwarded-host': 'cal.example', 'x-forwarded-proto': 'https' } })),
    'https://cal.example/api/google/callback',
  );
});

test('a product\'s return address survives both cookies, and an unsafe one is never accepted', () => {
  const state = 'b'.repeat(32);
  const back = 'https://app.brandbasket.in/social';
  const connect = connectCookie(state, 'brandbasket', back, true).split(';')[0]!.split('=')[1];
  assert.deepEqual(parseConnectCookie(connect), { state, brand: 'brandbasket', returnUrl: back });
  const waiting = pickCookie('brandbasket', SEALED, back, true).split(';')[0]!.slice('g_pick='.length);
  assert.deepEqual(parsePickCookie(waiting), { brand: 'brandbasket', sealed: SEALED, returnUrl: back });

  const unsafe = Buffer.from('javascript:alert(1)').toString('base64url');
  assert.equal(parseConnectCookie(`${state}.brandbasket.${unsafe}`), null);
  assert.equal(parsePickCookie(`brandbasket~${SEALED}~${unsafe}`), null);
  assert.throws(() => pickCookie('brandbasket', SEALED, 'http://evil.example/x'), /not a valid return address/);
});
