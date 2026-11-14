import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession } from './security.ts';
import { authorizeLink, callbackUrl, connectCookie, createInvite, isSafeReturnUrl, parseConnectCookie, verifyInvite } from './linkedin-flow.ts';

const SECRET = 'a-long-test-secret-a-long-test-secret';
const NOW = Date.parse('2026-11-02T10:00:00Z');

test('an invite names its client and works until it ends', () => {
  const invite = createInvite(SECRET, 'brandbasket', NOW);
  assert.deepEqual(verifyInvite(invite, SECRET, NOW + 1000), { brand: 'brandbasket', returnUrl: null, moveFrom: null });
  assert.equal(verifyInvite(invite, SECRET, NOW + 6 * 86_400_000)?.brand, 'brandbasket');
  assert.equal(verifyInvite(invite, SECRET, NOW + 8 * 86_400_000), null);
});

test('forged, edited, wrong-secret, malformed and session tokens are not invites', () => {
  const invite = createInvite(SECRET, 'brandbasket', NOW);
  const [payload, signature] = invite.split('.') as [string, string];
  const other = Buffer.from(JSON.stringify({ b: 'someone-else', e: 9_999_999_999 })).toString('base64url');
  assert.equal(verifyInvite(`${other}.${signature}`, SECRET, NOW), null);
  assert.equal(verifyInvite(invite, 'another-secret-another-secret-xx', NOW), null);
  assert.equal(verifyInvite(`${payload}.`, SECRET, NOW), null);
  assert.equal(verifyInvite('nonsense', SECRET, NOW), null);
  assert.equal(verifyInvite(null, SECRET, NOW), null);
  assert.equal(verifyInvite(invite, undefined, NOW), null);
  assert.equal(verifyInvite(createSession(SECRET, NOW), SECRET, NOW), null);
  assert.equal(verifyInvite(createInvite(SECRET, '../x', NOW), SECRET, NOW), null);
});

test('the state cookie round-trips and rejects malformed values', () => {
  const state = 'a'.repeat(32);
  const cookie = connectCookie(state, 'brandbasket', null, true);
  assert.match(cookie, /^li_connect=.*HttpOnly; Secure; SameSite=Lax; Path=\/api/);
  assert.deepEqual(parseConnectCookie(cookie.split(';')[0]!.split('=')[1]), { state, brand: 'brandbasket', returnUrl: null });
  assert.equal(parseConnectCookie('short.brand'), null);
  assert.equal(parseConnectCookie(undefined), null);
});

test('the LinkedIn link asks for sign-in and posting rights and returns to this site', () => {
  const link = new URL(authorizeLink({ clientId: 'cid', redirectUri: 'https://x/api/linkedin-callback', state: 's' }));
  assert.equal(link.searchParams.get('scope'), 'openid profile w_member_social');
  assert.equal(link.searchParams.get('redirect_uri'), 'https://x/api/linkedin-callback');
  assert.equal(
    callbackUrl(new Request('http://internal/api/x', { headers: { 'x-forwarded-host': 'cal.example', 'x-forwarded-proto': 'https' } })),
    'https://cal.example/api/linkedin-callback',
  );
});

test('an invite can carry the page to return to, and that survives the trip through the cookie; unsafe addresses never do', () => {
  const back = 'https://app.brandbasket.in/social?tab=channels';
  const invite = createInvite(SECRET, 'brandbasket', NOW, undefined, back);
  assert.deepEqual(verifyInvite(invite, SECRET, NOW), { brand: 'brandbasket', returnUrl: back, moveFrom: null });
  const state = 'b'.repeat(32);
  const value = connectCookie(state, 'brandbasket', back, true).split(';')[0]!.split('=')[1];
  assert.deepEqual(parseConnectCookie(value), { state, brand: 'brandbasket', returnUrl: back });
  assert.equal(verifyInvite(createInvite(SECRET, 'brandbasket', NOW, undefined, 'javascript:alert(1)'), SECRET, NOW), null);
  const tampered = `${state}.brandbasket.${Buffer.from('http://evil.example/x').toString('base64url')}`;
  assert.equal(parseConnectCookie(tampered), null);
  assert.equal(isSafeReturnUrl('http://localhost:3198/social'), true);
  assert.equal(isSafeReturnUrl('http://app.brandbasket.in/social'), false);
});
