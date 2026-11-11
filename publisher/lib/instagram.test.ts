import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { accountProfile, CAROUSEL_MAX, CAROUSEL_MIN, createCarouselContainer, createCarouselItem, InstagramApiError, mediaSince, prepareCarousel, refreshToken } from './instagram.ts';

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

test('a carousel picture is made as a carousel item, and the carousel container lists them in order with the caption', async () => {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), form: new URLSearchParams(String(init?.body)) });
    return Response.json({ id: `container-${calls.length}` });
  });
  try {
    assert.equal(await createCarouselItem('42', 'tok', 'https://cdn.example/one.jpg'), 'container-1');
    assert.equal(await createCarouselContainer('42', 'tok', ['a', 'b', 'c'], 'The caption.\n\n#tag'), 'container-2');
  } finally {
    fetchMock.mock.restore();
  }
  assert.match(calls[0]?.url ?? '', /\/42\/media$/);
  assert.equal(calls[0]?.form.get('is_carousel_item'), 'true');
  assert.equal(calls[0]?.form.get('image_url'), 'https://cdn.example/one.jpg');
  assert.equal(calls[0]?.form.get('caption'), null, 'a picture of a carousel carries no caption');
  assert.equal(calls[1]?.form.get('media_type'), 'CAROUSEL');
  assert.equal(calls[1]?.form.get('children'), 'a,b,c');
  assert.equal(calls[1]?.form.get('caption'), 'The caption.\n\n#tag');
  assert.equal(calls[1]?.form.get('is_carousel_item'), null);
});

test('a carousel needs between the least and the most pictures, and is refused before anything is sent', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ id: 'x' }));
  try {
    await assert.rejects(createCarouselContainer('42', 'tok', ['only-one'], 'c'), (e: unknown) => e instanceof InstagramApiError && /needs 2 to 10 pictures, not 1/.test(e.message));
    await assert.rejects(createCarouselContainer('42', 'tok', Array.from({ length: CAROUSEL_MAX + 1 }, (_, i) => `i${i}`), 'c'), /needs 2 to 10 pictures, not 11/);
    await assert.rejects(prepareCarousel('42', 'tok', ['https://cdn.example/one.jpg'], 'c'), /needs 2 to 10 pictures/);
    assert.equal(fetchMock.mock.callCount(), 0, 'nothing was sent');
    assert.equal(CAROUSEL_MIN, 2);
  } finally {
    fetchMock.mock.restore();
  }
});

test('prepareCarousel makes every picture, waits for each, then the carousel, and publishes nothing', async () => {
  const log: string[] = [];
  let n = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/media')) {
      const form = new URLSearchParams(String(init.body));
      n += 1;
      log.push(form.get('media_type') === 'CAROUSEL' ? `carousel(${form.get('children')})` : `item(${form.get('image_url')})`);
      return Response.json({ id: `c${n}` });
    }
    if (url.includes('media_publish')) log.push('PUBLISHED');
    if (url.includes('fields=status_code')) {
      log.push(`status(${/\/(c\d+)\?/.exec(url)?.[1]})`);
      return Response.json({ status_code: 'FINISHED' });
    }
    return Response.json({});
  });
  try {
    const made = await prepareCarousel('42', 'tok', ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg', 'https://cdn.example/3.jpg'], 'Caption');
    assert.deepEqual(made, { containerId: 'c4', itemIds: ['c1', 'c2', 'c3'] });
  } finally {
    fetchMock.mock.restore();
  }
  assert.deepEqual(log, ['item(https://cdn.example/1.jpg)', 'status(c1)', 'item(https://cdn.example/2.jpg)', 'status(c2)', 'item(https://cdn.example/3.jpg)', 'status(c3)', 'carousel(c1,c2,c3)', 'status(c4)']);
  assert.ok(!log.includes('PUBLISHED'));
});
