import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { InstagramApiError, refreshToken } from './instagram.ts';

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
