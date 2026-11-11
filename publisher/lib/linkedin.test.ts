import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { authorizeUrl, deletePost, deleteRestPost, exchangeCode, LINKEDIN_VERSION, LinkedInApiError, memberOf, MULTI_IMAGE_MAX, postImage, postMultiImage, uploadImage, uploadImageUrn } from './linkedin.ts';

const app = { clientId: 'cid', clientSecret: 'shh' };

test('authorizeUrl asks for sign-in and posting permission, and carries the state', () => {
  const url = new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'http://localhost:4030/callback', state: 's1' }));
  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.equal(url.searchParams.get('scope'), 'openid profile w_member_social');
  assert.equal(url.searchParams.get('state'), 's1');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:4030/callback');
});

test('exchangeCode keeps the secret in the body and returns the token and its life', async () => {
  let call: { url: string; body: string } | null = null;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    call = { url: String(input), body: String(init?.body) };
    return Response.json({ access_token: 'tok', expires_in: 5184000 });
  });
  try {
    assert.deepEqual(await exchangeCode(app, 'http://x/cb', 'CODE'), { accessToken: 'tok', expiresInSeconds: 5184000 });
  } finally {
    fetchMock.mock.restore();
  }
  const sent = call as unknown as { url: string; body: string };
  assert.ok(!sent.url.includes('shh'));
  assert.ok(sent.body.includes('client_secret=shh') && sent.body.includes('code=CODE'));
});

test('a refused exchange names the step and LinkedIn’s reason', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ error: 'invalid_request', error_description: 'bad redirect' }, { status: 400 }));
  try {
    await assert.rejects(exchangeCode(app, 'http://x/cb', 'c'), (e: unknown) => e instanceof LinkedInApiError && /code exchange failed.*bad redirect/.test(e.message));
  } finally {
    fetchMock.mock.restore();
  }
});

test('memberOf builds the person urn from the OpenID subject', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ sub: 'abc123', name: 'A B' }));
  try {
    assert.deepEqual(await memberOf('tok'), { urn: 'urn:li:person:abc123', name: 'A B' });
  } finally {
    fetchMock.mock.restore();
  }
});

test('uploadImage registers, uploads the bytes, and returns the asset; postImage then posts it', async () => {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(`${init?.method} ${String(input)}`);
    bodies.push(typeof init?.body === 'string' ? init.body : '[bytes]');
    if (String(input).includes('registerUpload')) {
      return Response.json({ value: { asset: 'urn:li:digitalmediaAsset:A1', uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.example/u' } } } });
    }
    if (String(input) === 'https://upload.example/u') return new Response(null, { status: 201 });
    return new Response('{}', { status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } });
  });
  try {
    const asset = await uploadImage('tok', 'urn:li:person:abc', Uint8Array.from([0xff, 0xd8]));
    assert.equal(asset, 'urn:li:digitalmediaAsset:A1');
    const post = await postImage('tok', 'urn:li:person:abc', asset, 'Hello #hi', 'CONNECTIONS');
    assert.deepEqual(post, { urn: 'urn:li:share:99', url: 'https://www.linkedin.com/feed/update/urn:li:share:99/' });
  } finally {
    fetchMock.mock.restore();
  }
  assert.deepEqual(urls, ['POST https://api.linkedin.com/v2/assets?action=registerUpload', 'PUT https://upload.example/u', 'POST https://api.linkedin.com/v2/ugcPosts']);
  const posted = JSON.parse(bodies[2] as string) as { author: string; visibility: Record<string, string>; specificContent: Record<string, { shareCommentary: { text: string } }> };
  assert.equal(posted.author, 'urn:li:person:abc');
  assert.equal(posted.visibility['com.linkedin.ugc.MemberNetworkVisibility'], 'CONNECTIONS');
  assert.equal(posted.specificContent['com.linkedin.ugc.ShareContent']?.shareCommentary.text, 'Hello #hi');
});

test('failures at each step are reported, and delete encodes the urn', async () => {
  const bad = mock.method(globalThis, 'fetch', async () => Response.json({ message: 'nope' }, { status: 403 }));
  try {
    await assert.rejects(uploadImage('tok', 'urn:li:person:a', Uint8Array.from([1])), /picture registration failed/);
    await assert.rejects(postImage('tok', 'urn:li:person:a', 'x', 'c', 'PUBLIC'), /post failed/);
    await assert.rejects(memberOf('tok'), /profile lookup failed/);
  } finally {
    bad.mock.restore();
  }
  let deleted = '';
  const ok = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    deleted = String(input);
    return new Response(null, { status: 204 });
  });
  try {
    await deletePost('tok', 'urn:li:share:99');
  } finally {
    ok.mock.restore();
  }
  assert.equal(deleted, 'https://api.linkedin.com/v2/ugcPosts/urn%3Ali%3Ashare%3A99');
});

test('uploadImageUrn asks the Images API for an upload, sends the bytes there, and answers the picture reference', async () => {
  const calls: Array<{ url: string; method?: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body });
    return calls.length === 1 ? Response.json({ value: { uploadUrl: 'https://upload.example/u/1', image: 'urn:li:image:ABC' } }) : new Response(null, { status: 201 });
  });
  try {
    assert.equal(await uploadImageUrn('tok', 'urn:li:person:me', new Uint8Array([1, 2, 3])), 'urn:li:image:ABC');
  } finally {
    fetchMock.mock.restore();
  }
  assert.equal(calls[0]?.url, 'https://api.linkedin.com/rest/images?action=initializeUpload');
  assert.equal(calls[0]?.headers['Linkedin-Version'], LINKEDIN_VERSION);
  assert.equal(calls[0]?.headers['X-Restli-Protocol-Version'], '2.0.0');
  assert.equal(calls[0]?.headers['Authorization'], 'Bearer tok');
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), { initializeUploadRequest: { owner: 'urn:li:person:me' } });
  assert.equal(calls[1]?.url, 'https://upload.example/u/1');
  assert.equal(calls[1]?.method, 'PUT');
});

test('a refused picture registration or upload names the step', async () => {
  const refused = mock.method(globalThis, 'fetch', async () => Response.json({ message: 'not allowed' }, { status: 403 }));
  try {
    await assert.rejects(uploadImageUrn('tok', 'urn:li:person:me', new Uint8Array([1])), (e: unknown) => e instanceof LinkedInApiError && /picture registration failed.*not allowed/.test(e.message));
  } finally {
    refused.mock.restore();
  }
  let n = 0;
  const upload = mock.method(globalThis, 'fetch', async () => (++n === 1 ? Response.json({ value: { uploadUrl: 'https://upload.example/u', image: 'urn:li:image:X' } }) : new Response(null, { status: 500 })));
  try {
    await assert.rejects(uploadImageUrn('tok', 'urn:li:person:me', new Uint8Array([1])), /picture upload failed.*500/);
  } finally {
    upload.mock.restore();
  }
});

test('postMultiImage sends the pictures in order as one post with the caption as its words, and answers the post address', async () => {
  let call: { url: string; headers: Record<string, string>; body: string } | null = null;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    call = { url: String(input), headers: init?.headers as Record<string, string>, body: String(init?.body) };
    return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123' } });
  });
  try {
    const post = await postMultiImage('tok', 'urn:li:person:me', [{ urn: 'urn:li:image:A', altText: 'Slide one' }, { urn: 'urn:li:image:B' }, { urn: 'urn:li:image:C' }], 'Words.\n\n#tag', 'CONNECTIONS');
    assert.deepEqual(post, { urn: 'urn:li:share:123', url: 'https://www.linkedin.com/feed/update/urn:li:share:123/' });
  } finally {
    fetchMock.mock.restore();
  }
  const sent = call as unknown as { url: string; headers: Record<string, string>; body: string };
  assert.equal(sent.url, 'https://api.linkedin.com/rest/posts');
  assert.equal(sent.headers['Linkedin-Version'], LINKEDIN_VERSION);
  const body = JSON.parse(sent.body) as Record<string, unknown>;
  assert.equal(body['author'], 'urn:li:person:me');
  assert.equal(body['commentary'], 'Words.\n\n#tag');
  assert.equal(body['visibility'], 'CONNECTIONS');
  assert.equal(body['lifecycleState'], 'PUBLISHED');
  assert.deepEqual(body['content'], { multiImage: { images: [{ id: 'urn:li:image:A', altText: 'Slide one' }, { id: 'urn:li:image:B' }, { id: 'urn:li:image:C' }] } });
});

test('a multi-image post is refused before anything is sent when it has too few or too many pictures, a wrong reference or a huge description', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } }));
  const img = (n: number) => ({ urn: `urn:li:image:${n}` });
  try {
    await assert.rejects(postMultiImage('tok', 'a', [img(1)], 'c', 'PUBLIC'), /needs 2 to 10 pictures, not 1/);
    await assert.rejects(postMultiImage('tok', 'a', Array.from({ length: MULTI_IMAGE_MAX + 1 }, (_, i) => img(i)), 'c', 'PUBLIC'), /needs 2 to 10 pictures, not 11/);
    await assert.rejects(postMultiImage('tok', 'a', [img(1), { urn: 'urn:li:digitalmediaAsset:old' }], 'c', 'PUBLIC'), /uploaded image reference/);
    await assert.rejects(postMultiImage('tok', 'a', [img(1), { urn: 'urn:li:image:2', altText: 'x'.repeat(4087) }], 'c', 'PUBLIC'), /longer than 4086/);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test('a refused multi-image post names LinkedIn\'s reason, and a post made with the Posts API can be deleted', async () => {
  const refused = mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Invalid version' }, { status: 426 }));
  try {
    await assert.rejects(postMultiImage('tok', 'a', [{ urn: 'urn:li:image:1' }, { urn: 'urn:li:image:2' }], 'c', 'PUBLIC'), /post failed.*Invalid version/);
  } finally {
    refused.mock.restore();
  }
  let call: { url: string; method?: string } | null = null;
  const del = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    call = { url: String(input), method: init?.method };
    return new Response(null, { status: 204 });
  });
  try {
    await deleteRestPost('tok', 'urn:li:share:123');
  } finally {
    del.mock.restore();
  }
  assert.deepEqual(call, { url: 'https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A123', method: 'DELETE' });
});
