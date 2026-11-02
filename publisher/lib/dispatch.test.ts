import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POST as connect } from '../api/connect.ts';
import { DELETE, GET, POST } from '../api/v1/[step].ts';

const call = (path: string, init?: RequestInit): Request => new Request(`http://localhost:4020${path}`, init);

test('every connect address reaches its own handler, which turns away a caller without the dashboard secret', async () => {
  delete process.env['EDIT_SECRET'];
  for (const name of ['facebook', 'google', 'instagram', 'linkedin']) {
    assert.equal((await connect(call(`/api/${name}-connect`, { method: 'POST' }))).status, 401, name);
    assert.equal((await connect(call(`/api/connect?step=${name}-connect`, { method: 'POST' }))).status, 401, name);
  }
  assert.equal((await connect(call('/api/connect', { method: 'POST' }))).status, 404);
  assert.equal((await connect(call('/api/connect?step=nope', { method: 'POST' }))).status, 404);
});

test('every product endpoint is reached by its address and answers a caller with no key as unauthorised, never as missing', async () => {
  delete process.env['PRODUCTS'];
  for (const name of ['workspaces', 'posts']) assert.notEqual((await GET(call(`/api/v1/${name}?externalId=x`))).status, 404, name);
  for (const name of ['workspaces', 'connect-link', 'pictures', 'posts']) assert.notEqual((await POST(call(`/api/v1/${name}`, { method: 'POST', body: '{}' }))).status, 404, name);
  assert.notEqual((await DELETE(call('/api/v1/posts?externalId=x&postId=y', { method: 'DELETE' }))).status, 404);
});

test('an address the product API does not have, or a method it does not allow, is a 404', async () => {
  assert.equal((await GET(call('/api/v1/nope'))).status, 404);
  assert.equal((await GET(call('/api/v1/pictures'))).status, 404);
  assert.equal((await POST(call('/api/v1/nope', { method: 'POST' }))).status, 404);
  assert.equal((await DELETE(call('/api/v1/workspaces', { method: 'DELETE' }))).status, 404);
});
