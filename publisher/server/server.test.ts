import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentTypeFor, publicFile } from './files.ts';
import { matchRoute } from './routes.ts';

test('publicFile serves only poster pictures and robots.txt, and never leaves the folder', () => {
  const dir = '/srv/publisher/public';
  assert.equal(publicFile(dir, '/posts/brandbasket/abc123.jpg'), '/srv/publisher/public/posts/brandbasket/abc123.jpg');
  assert.equal(publicFile(dir, '/robots.txt'), '/srv/publisher/public/robots.txt');
  for (const bad of ['/posts/../../etc/passwd', '/posts/%2e%2e/%2e%2e/etc/passwd.jpg', '/posts/a%00.jpg', '/posts/a\\b.jpg', '/api/status', '/posts/x.html', '/posts/', '/', '/posts/%zz.jpg']) {
    assert.equal(publicFile(dir, bad), null, bad);
  }
});

test('contentTypeFor knows pictures and falls back safely', () => {
  assert.equal(contentTypeFor('/a/b.JPG'), 'image/jpeg');
  assert.equal(contentTypeFor('/a/b.png'), 'image/png');
  assert.equal(contentTypeFor('/a/b.bin'), 'application/octet-stream');
});

test('matchRoute finds addresses, ignores a trailing slash, and tells apart not found from wrong method', () => {
  assert.equal(matchRoute('GET', '/api/cron').kind, 'ok');
  assert.equal(matchRoute('GET', '/api/cron/').kind, 'ok');
  assert.equal(matchRoute('POST', '/api/cron').kind, 'method-not-allowed');
  assert.equal(matchRoute('GET', '/api/nope').kind, 'not-found');
  assert.equal(matchRoute('DELETE', '/api/v1/posts').kind, 'ok');
  assert.equal(matchRoute('POST', '/api/linkedin-connect').kind, 'ok');
});
