import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheControlFor, contentTypeFor, SECURITY_HEADERS, staticFile } from './files.ts';
import { matchRoute } from './routes.ts';

test('staticFile maps the app and sign-in pages, serves files, and refuses anything that escapes or hides', () => {
  const dir = '/srv/dashboard/public';
  assert.equal(staticFile(dir, '/'), '/srv/dashboard/public/index.html');
  assert.equal(staticFile(dir, '/login'), '/srv/dashboard/public/login.html');
  assert.equal(staticFile(dir, '/styles.css'), '/srv/dashboard/public/styles.css');
  assert.equal(staticFile(dir, '/assets/web/app.js'), '/srv/dashboard/public/assets/web/app.js');
  for (const bad of ['/../secret', '/%2e%2e/secret', '/a%00b', '/a\\b', '/.env', '/assets/.hidden', '/%zz']) {
    assert.equal(staticFile(dir, bad), null, bad);
  }
});

test('content types and cache rules', () => {
  assert.equal(contentTypeFor('x.woff2'), 'font/woff2');
  assert.equal(contentTypeFor('x.JS'), 'text/javascript; charset=utf-8');
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream');
  assert.match(cacheControlFor('/help/facebook/f1.jpg'), /max-age=86400/);
  assert.match(cacheControlFor('/fonts/a.woff2'), /immutable/);
  assert.equal(cacheControlFor('/assets/web/app.js'), 'no-cache');
});

test('every response carries the protective headers the Vercel config used to add', () => {
  assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  assert.match(SECURITY_HEADERS['Content-Security-Policy'] ?? '', /default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
});

test('matchRoute distinguishes not found from a wrong method, including routes with several methods', () => {
  assert.equal(matchRoute('POST', '/api/auth/login').kind, 'ok');
  assert.equal(matchRoute('GET', '/api/auth/login').kind, 'method-not-allowed');
  assert.equal(matchRoute('GET', '/api/google/pick').kind, 'ok');
  assert.equal(matchRoute('POST', '/api/google/pick').kind, 'ok');
  assert.equal(matchRoute('GET', '/api/nothing').kind, 'not-found');
  assert.equal(matchRoute('GET', '/api/linkedin-callback/').kind, 'ok');
});
