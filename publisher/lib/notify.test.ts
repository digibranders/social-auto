import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { asciiHeader, notify } from './notify.ts';

test('asciiHeader replaces characters that are not valid in HTTP headers', () => {
  assert.equal(asciiHeader('Café post ✓'), 'Caf? post ?');
  assert.equal(asciiHeader('Plain title'), 'Plain title');
});

test('notify does nothing without a topic', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('ok'));
  try {
    assert.equal(await notify({ title: 't', message: 'm' }, ''), false);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test('notify posts to the topic with safe headers and a trimmed body', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('ok'));
  try {
    const sent = await notify({ title: 'Post ✓', message: 'x'.repeat(5_000), priority: 'high', tags: 'rotating_light' }, 'my topic');
    assert.equal(sent, true);
    const [url, init] = fetchMock.mock.calls[0]?.arguments as unknown as [string, RequestInit];
    assert.equal(url, 'https://ntfy.sh/my%20topic');
    assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { Title: 'Post ?', Priority: 'high', Tags: 'rotating_light' });
    assert.equal((init.body as string).length, 1_000);
  } finally {
    fetchMock.mock.restore();
  }
});

test('notify never throws: network errors and bad responses return false', async () => {
  const failing = mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down');
  });
  try {
    assert.equal(await notify({ title: 't', message: 'm' }, 'topic'), false);
  } finally {
    failing.mock.restore();
  }
  const rejected = mock.method(globalThis, 'fetch', async () => new Response('no', { status: 500 }));
  try {
    assert.equal(await notify({ title: 't', message: 'm' }, 'topic'), false);
  } finally {
    rejected.mock.restore();
  }
});
