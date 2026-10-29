import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearedSessionCookie,
  createSession,
  isSignedIn,
  passwordMatches,
  readCookie,
  sessionCookie,
  SESSION_COOKIE,
  verifySession,
} from './security.ts';

const NOW = Date.parse('2026-12-10T10:00:00Z');
const SECRET = 'test-secret-test-secret';

test('a fresh session verifies, and expires after its lifetime', () => {
  const token = createSession(SECRET, NOW, 60);
  assert.equal(verifySession(token, SECRET, NOW + 59_000), true);
  assert.equal(verifySession(token, SECRET, NOW + 61_000), false);
});

test('a session is rejected when tampered with, signed with another secret, or malformed', () => {
  const token = createSession(SECRET, NOW);
  const [payload = '', signature = ''] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ exp: 9_999_999_999 })).toString('base64url');
  assert.equal(verifySession(`${forged}.${signature}`, SECRET, NOW), false);
  assert.equal(verifySession(`${payload}.${signature}x`, SECRET, NOW), false);
  assert.equal(verifySession(token, 'another-secret', NOW), false);
  assert.equal(verifySession('not-a-token', SECRET, NOW), false);
  assert.equal(verifySession(`${payload}.${signature}.extra`, SECRET, NOW), false);
  assert.equal(verifySession(undefined, SECRET, NOW), false);
  assert.equal(verifySession(token, undefined, NOW), false);
});

test('readCookie finds a cookie among several and keeps "=" inside values', () => {
  assert.equal(readCookie('a=1; cal_session=abc.def=; b=2', 'cal_session'), 'abc.def=');
  assert.equal(readCookie('a=1', 'cal_session'), undefined);
  assert.equal(readCookie(null, 'cal_session'), undefined);
});

test('the session cookie is HttpOnly, Secure and SameSite, and can be cleared', () => {
  const cookie = sessionCookie('v', 100, true);
  assert.match(cookie, /^cal_session=v; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=100$/);
  assert.ok(!sessionCookie('v', 100, false).includes('Secure'));
  assert.match(clearedSessionCookie(), /Max-Age=0$/);
});

test('passwordMatches compares exactly and refuses when nothing is configured', () => {
  assert.equal(passwordMatches('correct horse', 'correct horse'), true);
  assert.equal(passwordMatches('correct horse ', 'correct horse'), false);
  assert.equal(passwordMatches('', 'correct horse'), false);
  assert.equal(passwordMatches('anything', undefined), false);
  assert.equal(passwordMatches('', ''), false);
});

test('isSignedIn reads the session from the request cookie', () => {
  const token = createSession(SECRET, NOW);
  const signedIn = new Request('https://example.com/api/data', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  assert.equal(isSignedIn(signedIn, SECRET, NOW), true);
  assert.equal(isSignedIn(new Request('https://example.com/api/data'), SECRET, NOW), false);
});
