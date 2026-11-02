import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { authorizeUrl, deletePost, exchangeCode, LinkedInApiError, memberOf, postImage, uploadImage } from './linkedin.ts';

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
