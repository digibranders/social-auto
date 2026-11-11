import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { authorizeUrl, deletePost, exchangeCode, FacebookApiError, listPages, longLivedUserToken, postPhoto, postPhotos } from './facebook.ts';

const app = { appId: '111', appSecret: 'shh' };

test('authorizeUrl asks for the Page scopes, or a configuration for Login for Business', () => {
  const plain = new URL(authorizeUrl({ appId: '111', redirectUri: 'http://localhost:4020/callback', state: 's1' }));
  assert.equal(plain.origin + plain.pathname, 'https://www.facebook.com/v23.0/dialog/oauth');
  assert.equal(plain.searchParams.get('scope'), 'pages_show_list,pages_manage_posts,pages_read_engagement');
  assert.equal(plain.searchParams.get('state'), 's1');
  assert.equal(plain.searchParams.get('redirect_uri'), 'http://localhost:4020/callback');
  const business = new URL(authorizeUrl({ appId: '111', redirectUri: 'http://x/cb', state: 's', configId: '999' }));
  assert.equal(business.searchParams.get('config_id'), '999');
  assert.equal(business.searchParams.get('scope'), null);
});

test('exchangeCode and longLivedUserToken send secrets in the body, not the address', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body) });
    return Response.json({ access_token: `tok${calls.length}` });
  });
  try {
    assert.equal(await exchangeCode(app, 'http://x/cb', 'CODE'), 'tok1');
    assert.equal(await longLivedUserToken(app, 'tok1'), 'tok2');
  } finally {
    fetchMock.mock.restore();
  }
  for (const call of calls) {
    assert.ok(!call.url.includes('shh'));
    assert.ok(call.body.includes('client_secret=shh'));
  }
  assert.ok(calls[0]?.body.includes('code=CODE'));
  assert.ok(calls[1]?.body.includes('fb_exchange_token=tok1'));
});

test('listPages keeps only Pages that came with a token', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json({ data: [{ id: '1', name: 'Brandbs', access_token: 'pt' }, { id: '2', name: 'No token' }] }),
  );
  try {
    assert.deepEqual(await listPages('ut'), [{ id: '1', name: 'Brandbs', accessToken: 'pt' }]);
  } finally {
    fetchMock.mock.restore();
  }
});

test('postPhoto uploads the picture and caption, and reports the ids', async () => {
  let sent: FormData | null = null;
  const fetchMock = mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    sent = init?.body as FormData;
    return Response.json({ id: '555', post_id: '1_555' });
  });
  try {
    const result = await postPhoto('1', 'pt', Uint8Array.from([0xff, 0xd8, 0xff]), 'Hello #hi');
    assert.deepEqual(result, { photoId: '555', postId: '1_555' });
  } finally {
    fetchMock.mock.restore();
  }
  const form = sent as unknown as FormData;
  assert.equal(form.get('caption'), 'Hello #hi');
  assert.equal(form.get('published'), 'true');
  assert.ok(form.get('source') instanceof Blob);
});

test('Facebook errors are reported with the step, and an answer without a token is an error too', async () => {
  const bad = mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'Invalid code', code: 100 } }, { status: 400 }));
  try {
    await assert.rejects(exchangeCode(app, 'http://x/cb', 'bad'), (e: unknown) => e instanceof FacebookApiError && /code exchange failed.*Invalid code/.test(e.message));
  } finally {
    bad.mock.restore();
  }
  const empty = mock.method(globalThis, 'fetch', async () => Response.json({}));
  try {
    await assert.rejects(exchangeCode(app, 'http://x/cb', 'c'), /no "access_token"/);
    await assert.rejects(deletePost('1_5', 'pt'), /delete post failed/);
  } finally {
    empty.mock.restore();
  }
});

test('postPhotos uploads each picture unpublished, then makes one post that attaches them in order', async () => {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), form: new URLSearchParams(String(init?.body)) });
    return Response.json({ id: calls.length < 4 ? `photo${calls.length}` : '77_post9' });
  });
  try {
    const posted = await postPhotos('77', 'page-token', ['https://p.example/1.jpg', 'https://p.example/2.jpg', 'https://p.example/3.jpg'], 'The words.\n\n#tag');
    assert.deepEqual(posted, { postId: '77_post9' });
  } finally {
    fetchMock.mock.restore();
  }
  assert.equal(calls.length, 4);
  assert.match(calls[0]?.url ?? '', /\/77\/photos$/);
  assert.equal(calls[0]?.form.get('url'), 'https://p.example/1.jpg');
  assert.equal(calls[0]?.form.get('published'), 'false');
  assert.equal(calls[0]?.form.get('caption'), null, 'the words belong to the post, not to a picture');
  assert.match(calls[3]?.url ?? '', /\/77\/feed$/);
  assert.equal(calls[3]?.form.get('message'), 'The words.\n\n#tag');
  assert.equal(calls[3]?.form.get('attached_media[0]'), JSON.stringify({ media_fbid: 'photo1' }));
  assert.equal(calls[3]?.form.get('attached_media[2]'), JSON.stringify({ media_fbid: 'photo3' }));
});

test('postPhotos refuses too few or too many pictures before sending, and names the step that failed', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'bad picture' } }, { status: 400 }));
  try {
    await assert.rejects(postPhotos('77', 't', ['https://p.example/1.jpg'], 'c'), (e: unknown) => e instanceof FacebookApiError && /needs 2 to 10 pictures, not 1/.test(e.message));
    await assert.rejects(postPhotos('77', 't', Array.from({ length: 11 }, (_, i) => `https://p.example/${i}.jpg`), 'c'), /needs 2 to 10 pictures, not 11/);
    assert.equal(fetchMock.mock.callCount(), 0, 'nothing was sent');
    await assert.rejects(postPhotos('77', 't', ['https://p.example/1.jpg', 'https://p.example/2.jpg'], 'c'), /photo upload failed.*bad picture/);
  } finally {
    fetchMock.mock.restore();
  }
});
