import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError, isAuthorized } from './http.ts';

const request = (authorization?: string): Request =>
  new Request('https://example.com/api/cron', { headers: authorization ? { authorization } : {} });

test('isAuthorized accepts only the exact bearer secret', () => {
  assert.equal(isAuthorized(request('Bearer s3cret'), 's3cret'), true);
  assert.equal(isAuthorized(request('Bearer wrong!'), 's3cret'), false);
  assert.equal(isAuthorized(request('Bearer s3cre'), 's3cret'), false);
  assert.equal(isAuthorized(request(), 's3cret'), false);
});

test('isAuthorized refuses everything when no secret is configured', () => {
  assert.equal(isAuthorized(request('Bearer '), ''), false);
  assert.equal(isAuthorized(request('Bearer undefined'), undefined), false);
});

test('an unset secret never falls back to another endpoint secret', () => {
  const previous = process.env['CRON_SECRET'];
  process.env['CRON_SECRET'] = 'cron-secret';
  try {
    assert.equal(isAuthorized(request('Bearer cron-secret'), undefined), false);
    assert.equal(isAuthorized(request('Bearer cron-secret'), 'status-secret'), false);
  } finally {
    if (previous === undefined) delete process.env['CRON_SECRET'];
    else process.env['CRON_SECRET'] = previous;
  }
});

test('describeError names the error type and tolerates non-errors', () => {
  assert.equal(describeError(new TypeError('bad')), 'TypeError: bad');
  assert.equal(describeError('plain'), 'plain');
});
