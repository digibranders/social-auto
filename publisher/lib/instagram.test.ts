import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { accountProfile, InstagramApiError, mediaSince, refreshToken } from './instagram.ts';

test('accountProfile returns the username and picture, and tolerates missing fields', async () => {
  const full = mock.method(globalThis, 'fetch', async () => Response.json({ username: 'dai23_sy', profile_picture_url: 'https://cdn.example/me.jpg' }));
  try {
    assert.deepEqual(await accountProfile('tok'), { username: 'dai23_sy', pictureUrl: 'https://cdn.example/me.jpg' });
  } finally {
    full.mock.restore();
  }
  const bare = mock.method(globalThis, 'fetch', async () => Response.json({ id: '1' }));
  try {
    assert.deepEqual(await accountProfile('tok'), { username: null, pictureUrl: null });
  } finally {
    bare.mock.restore();
  }
});

test('mediaSince follows paging and stops at posts older than the cut-off', async () => {
  const item = (id: string, timestamp: string, extra: Record<string, unknown> = {}) => ({
    id,
    caption: `caption ${id}`,
    timestamp,
    permalink: `https://instagram.com/p/${id}/`,
    media_type: 'IMAGE',
    media_url: `https://cdn.example/${id}.jpg`,
    ...extra,
  });
  const pages = [
    { data: [item('1', '2026-12-09T05:00:00+0000'), item('2', '2026-12-08T05:00:00+0000')], paging: { next: 'https://graph.example/page2' } },
    { data: [item('3', '2026-12-07T05:00:00+0000', { media_type: 'VIDEO', thumbnail_url: 'https://cdn.example/3-thumb.jpg' }), item('4', '2026-11-01T05:00:00+0000')] },
  ];
  const urls: string[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json(pages[urls.length - 1] ?? { data: [] });
  });
  try {
    const result = await mediaSince('42', 'tok', Date.parse('2026-12-01T00:00:00Z'));
    assert.deepEqual(result.map((m) => m.id), ['1', '2', '3']);
    assert.equal(result[2]?.mediaUrl, 'https://cdn.example/3-thumb.jpg');
    assert.equal(urls.length, 2);
    assert.equal(urls[1], 'https://graph.example/page2');
  } finally {
    fetchMock.mock.restore();
  }
});

test('refreshToken returns the token and its remaining life in days', async () => {
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async () => Response.json({ access_token: 'IGAAnew', token_type: 'bearer', expires_in: 5_183_944 }),
  );
  try {
    assert.deepEqual(await refreshToken('IGAAold'), { token: 'IGAAnew', expiresInDays: 59 });
    const [url] = fetchMock.mock.calls[0]?.arguments as unknown as [string];
    assert.match(url, /^https:\/\/graph\.instagram\.com\/refresh_access_token\?/);
    assert.match(url, /grant_type=ig_refresh_token/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('refreshToken throws a descriptive error that does not contain the token', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: 'Session has expired', code: 190 } }, { status: 400 }),
  );
  try {
    await assert.rejects(refreshToken('IGAA-secret-token'), (error: unknown) => {
      assert.ok(error instanceof InstagramApiError);
      assert.match(error.message, /Session has expired/);
      assert.ok(!error.message.includes('IGAA-secret-token'));
      return true;
    });
  } finally {
    fetchMock.mock.restore();
  }
});
