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

test('describeError names the error type and tolerates non-errors', () => {
  assert.equal(describeError(new TypeError('bad')), 'TypeError: bad');
  assert.equal(describeError('plain'), 'plain');
});
