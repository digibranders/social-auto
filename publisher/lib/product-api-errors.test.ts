import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { POST as connectLink } from '../api/_v1/connect-link.ts';
import { POST as picturesPost } from '../api/_v1/pictures.ts';
import { DELETE as postsDelete, GET as postsGet, PATCH as postsPatch, POST as postsPost } from '../api/_v1/posts.ts';
import { POST as sendNow } from '../api/_v1/send.ts';
import { GET as workspacesGet, POST as workspacesPost } from '../api/_v1/workspaces.ts';
import { apiError, channelProblem, codeForStatus, ERROR_CODES, errorResponse, type ErrorCode } from './api-error.ts';
import { addLinkedInMember, postedKey } from './channels.ts';
import { parseKey } from './crypto.ts';
import { EditError } from './overrides.ts';
import { hashKey } from './products.ts';
import { loadManual, loadPosted, saveChannels, saveManual, savePauses, savePosted } from './store.ts';

const KEY = 'test-product-key-0123456789abcdef';
const CHANNEL_KEY = '33'.repeat(32);
const ENV_NAMES = ['LOCAL_STORE_DIR', 'BLOB_READ_WRITE_TOKEN', 'PRODUCTS', 'INVITE_SECRET', 'DASHBOARD_ORIGIN', 'CHANNEL_KEY', 'PUBLIC_ORIGIN'] as const;

/** A minimal JPEG header: SOI, then a baseline start-of-frame carrying the size. */
function jpeg(width: number, height: number, extra = 0): Uint8Array {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
  return Uint8Array.from([...bytes, ...new Array<number>(extra).fill(0)]);
}

/** A throwaway store, a product with a known key, and the connect-link settings; the environment is put back afterwards. */
async function withProduct(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'product-api-errors-'));
  const before = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  process.env['LOCAL_STORE_DIR'] = dir;
  process.env['PRODUCTS'] = JSON.stringify([{ id: 'brandbasket', keyHash: hashKey(KEY), returnUrls: ['https://app.example.test/social'] }]);
  process.env['INVITE_SECRET'] = 'i'.repeat(40);
  process.env['DASHBOARD_ORIGIN'] = 'https://social.example.test';
  process.env['CHANNEL_KEY'] = CHANNEL_KEY;
  delete process.env['BLOB_READ_WRITE_TOKEN'];
  const logged = console.error;
  console.error = (): void => undefined;
  try {
    await run();
  } finally {
    console.error = logged;
    for (const name of ENV_NAMES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

type Handler = (request: Request) => Promise<Response>;
interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function call(handler: Handler, path: string, init: { method?: string; key?: string | null; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? KEY}` }), ...init.headers };
  const body = init.bytes !== undefined ? new Blob([init.bytes as unknown as BlobPart]) : init.json !== undefined ? JSON.stringify(init.json) : undefined;
  if (init.bytes !== undefined) headers['content-type'] = 'image/jpeg';
  else if (init.json !== undefined) headers['content-type'] = 'application/json';
  const response = await handler(new Request(`https://social.example.test${path}`, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body === undefined ? {} : { body }) }));
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The answer is an error with this status and code, a plain sentence, and nothing else that would only help a developer. */
function expectError(answer: Answer, status: number, code: ErrorCode, label: string): void {
  assert.equal(answer.status, status, `${label}: status (${JSON.stringify(answer.body)})`);
  assert.equal(answer.body['code'], code, `${label}: code (${JSON.stringify(answer.body)})`);
  assert.equal(typeof answer.body['error'], 'string', `${label}: a sentence`);
  assert.notEqual(String(answer.body['error']).trim(), '', `${label}: the sentence is not empty`);
  assert.deepEqual(Object.keys(answer.body).sort(), ['code', 'error'], `${label}: only code and error`);
}

const istDay = (offsetDays: number): string => new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** A workspace with a LinkedIn account connected an hour ago (a post dated now is only sent to accounts that were already connected) and a picture, ready for posts. */
async function workspaceWithAccount(lifeSeconds = 5_000_000): Promise<{ brand: string; pictureId: string; channelId: string }> {
  const made = await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop One' } });
  const brand = String((made.body['workspace'] as { id: string }).id);
  await saveChannels(addLinkedInMember({ channels: [] }, brand, { urn: 'urn:li:person:abc12345', name: 'Test Member' }, 'token', lifeSeconds, parseKey(CHANNEL_KEY), Date.now() - 3600_000), null);
  const picture = await call(picturesPost, '/api/v1/pictures', { bytes: jpeg(1080, 1080) });
  assert.equal(picture.status, 201);
  return { brand, pictureId: String(picture.body['pictureId']), channelId: 'linkedin:abc12345' };
}

test('the codes are a fixed list that fits the status of an answer', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length, 'no code is listed twice');
  for (const code of ERROR_CODES) assert.match(code, /^[A-Z][A-Z_]+$/, code);
  assert.equal(codeForStatus(400), 'INVALID_REQUEST');
  assert.equal(codeForStatus(401), 'UNAUTHORIZED');
  assert.equal(codeForStatus(404), 'NOT_FOUND');
  assert.equal(codeForStatus(409), 'CONFLICT');
  assert.equal(codeForStatus(413), 'REQUEST_TOO_LARGE');
  assert.equal(codeForStatus(503), 'SERVICE_UNAVAILABLE');
  assert.equal(codeForStatus(500), 'INTERNAL');
  assert.equal(codeForStatus(418), 'INTERNAL');
});

test('an answer is a sentence and a code, and an unexpected failure never leaks its own words', async () => {
  const made = apiError(404, 'POST_NOT_FOUND', 'no such post');
  assert.equal(made.status, 404);
  assert.deepEqual(await made.json(), { error: 'no such post', code: 'POST_NOT_FOUND' });
  assert.equal(made.headers.get('cache-control'), 'no-store');

  const known = errorResponse(new EditError('the picture was not found. Add it again.', 400, 'PICTURE_NOT_FOUND'), 'schedule the post');
  assert.deepEqual(await known.json(), { error: 'the picture was not found. Add it again.', code: 'PICTURE_NOT_FOUND' });
  const bare = errorResponse(new EditError('no such thing', 404), 'schedule the post');
  assert.deepEqual(await bare.json(), { error: 'no such thing', code: 'NOT_FOUND' }, 'an error without a code gets the code of its status');

  const unexpected = errorResponse(new Error('ENOENT: /srv/secret/path.json'), 'schedule the post');
  assert.equal(unexpected.status, 500);
  assert.deepEqual(await unexpected.json(), { error: 'could not schedule the post', code: 'INTERNAL' });
});

test('a channel that refused a post is explained by a code and a plain sentence, never by its raw error', () => {
  const unreachable = channelProblem('Test Member', 'fetch failed');
  assert.deepEqual(unreachable, { account: 'Test Member', code: 'CHANNEL_UNREACHABLE', error: 'Test Member could not be reached just now. It will be tried again.' });
  assert.equal(channelProblem('Page', 'The operation was aborted due to timeout').code, 'CHANNEL_UNREACHABLE');
  assert.equal(channelProblem('Page', 'connect ECONNREFUSED 127.0.0.1:4041').code, 'CHANNEL_UNREACHABLE');
  const expired = channelProblem('Test Member', 'The LinkedIn connection for Test Member has expired. They need to open their connect link again and press Allow.');
  assert.deepEqual(expired, { account: 'Test Member', code: 'RECONNECT_NEEDED', error: 'Test Member needs to be connected again.' });
  assert.equal(channelProblem('Cafe', 'access was withdrawn or expired. Connect Google again from the dashboard.').code, 'RECONNECT_NEEDED');
  const refused = channelProblem('Test Cafe', 'Google post failed: no such location /accounts/1/locations/9 token=abc');
  assert.deepEqual(refused, { account: 'Test Cafe', code: 'CHANNEL_REFUSED', error: 'Test Cafe did not accept the post.' });
  for (const problem of [unreachable, expired, refused]) assert.doesNotMatch(problem.error, /fetch|expired|token|accounts\/1|Google post failed/);
});

test('every code is documented, and the documentation names no code that does not exist', () => {
  const doc = readFileSync(new URL('../../docs/product-api.md', import.meta.url), 'utf8');
  const documented = [...doc.matchAll(/^\| `([A-Z][A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...documented].sort(), [...ERROR_CODES].sort());
});

test('the shared answers of every v1 endpoint carry a code', async () => {
  await withProduct(async () => {
    expectError(await call(workspacesGet, '/api/v1/workspaces?externalId=x', { key: null }), 401, 'UNAUTHORIZED', 'no key');
    expectError(await call(workspacesGet, '/api/v1/workspaces?externalId=x', { key: 'wrong-key' }), 401, 'UNAUTHORIZED', 'wrong key');
    expectError(await call(workspacesGet, '/api/v1/workspaces'), 400, 'INVALID_EXTERNAL_ID', 'externalId missing');
    expectError(await call(workspacesGet, '/api/v1/workspaces?externalId=nobody'), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
    expectError(await call(workspacesPost, '/api/v1/workspaces', { method: 'POST', json: { name: 'No id' } }), 400, 'INVALID_EXTERNAL_ID', 'create without externalId');
    expectError(await call(workspacesPost, '/api/v1/workspaces', { method: 'POST', json: null }), 400, 'INVALID_REQUEST', 'create with no JSON object');
    expectError(await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'a', name: 'A' }, headers: { 'content-length': '999999' } }), 413, 'REQUEST_TOO_LARGE', 'body too large');
    expectError(await call(sendNow, '/api/v1/send', { json: { externalId: 'nobody', postId: 'manual-aaaaaaaaaaaa' } }), 404, 'WORKSPACE_NOT_FOUND', 'send for an unknown workspace');
    expectError(await call(sendNow, '/api/v1/send', { json: { externalId: 'shop-1', postId: 'x' } }), 400, 'INVALID_REQUEST', 'send with a bad post id');
    expectError(await call(postsGet, '/api/v1/posts?externalId=nobody'), 404, 'WORKSPACE_NOT_FOUND', 'posts of an unknown workspace');
  });
  await withProduct(async () => {
    delete process.env['LOCAL_STORE_DIR'];
    expectError(await call(workspacesGet, '/api/v1/workspaces?externalId=x'), 503, 'STORAGE_NOT_SET_UP', 'no storage');
  });
  await withProduct(async () => {
    process.env['PRODUCTS'] = 'not json';
    expectError(await call(workspacesGet, '/api/v1/workspaces?externalId=x'), 500, 'SERVICE_NOT_CONFIGURED', 'bad settings');
  });
});

test('connect-link errors carry a code', async () => {
  await withProduct(async () => {
    await call(workspacesPost, '/api/v1/workspaces', { json: { externalId: 'shop-1', name: 'Shop One' } });
    const base = { externalId: 'shop-1', channel: 'linkedin', returnUrl: 'https://app.example.test/social' };
    expectError(await call(connectLink, '/api/v1/connect-link', { json: { ...base, channel: 'twitter' } }), 400, 'INVALID_CHANNEL', 'bad channel');
    expectError(await call(connectLink, '/api/v1/connect-link', { json: { ...base, returnUrl: 'https://evil.example/steal' } }), 400, 'RETURN_URL_NOT_REGISTERED', 'unregistered return address');
    expectError(await call(connectLink, '/api/v1/connect-link', { json: { ...base, externalId: 'nobody' } }), 404, 'WORKSPACE_NOT_FOUND', 'unknown workspace');
    expectError(await call(connectLink, '/api/v1/connect-link', { json: { channel: 'linkedin' } }), 400, 'INVALID_EXTERNAL_ID', 'no externalId');
    process.env['INVITE_SECRET'] = 'short';
    expectError(await call(connectLink, '/api/v1/connect-link', { json: base }), 503, 'CONNECT_LINKS_NOT_SET_UP', 'connect links not set up');
  });
});

test('picture errors carry a code that says which rule was broken', async () => {
  await withProduct(async () => {
    expectError(await call(picturesPost, '/api/v1/pictures', { bytes: new Uint8Array(0) }), 400, 'PICTURE_REQUIRED', 'empty body');
    expectError(await call(picturesPost, '/api/v1/pictures', { bytes: Uint8Array.from([1, 2, 3, 4]) }), 400, 'PICTURE_NOT_JPG', 'not a JPG');
    expectError(await call(picturesPost, '/api/v1/pictures', { bytes: jpeg(200, 200) }), 400, 'PICTURE_TOO_SMALL', 'too small');
    expectError(await call(picturesPost, '/api/v1/pictures', { bytes: jpeg(800, 500) }), 400, 'PICTURE_NOT_SQUARE', 'not square');
    expectError(await call(picturesPost, '/api/v1/pictures', { bytes: jpeg(5000, 5000) }), 400, 'PICTURE_TOO_LARGE', 'too many pixels');
    expectError(await call(picturesPost, '/api/v1/pictures', { bytes: jpeg(1080, 1080, 4 * 1024 * 1024) }), 413, 'PICTURE_TOO_LARGE', 'too many bytes');
  });
});

test('post errors carry a code that says what to fix', async () => {
  await withProduct(async () => {
    const { pictureId } = await workspaceWithAccount();
    const ok = { externalId: 'shop-1', day: istDay(2), time: '11:30', caption: 'Fresh laddoos.', pictureId, channels: ['linkedin:abc12345'] };
    const post = (change: Record<string, unknown>): Promise<Answer> => call(postsPost, '/api/v1/posts', { json: { ...ok, ...change } });
    expectError(await post({ day: '2020-01-01', time: undefined }), 400, 'DAY_PASSED', 'a day in the past');
    expectError(await post({ day: istDay(0), time: '00:00' }), 400, 'TIME_PASSED', 'a time already passed today');
    expectError(await post({ day: istDay(120) }), 400, 'TOO_FAR_AHEAD', 'too far ahead');
    expectError(await post({ day: 'tomorrow' }), 400, 'INVALID_DAY', 'not a day');
    expectError(await post({ day: '2026-02-30' }), 400, 'INVALID_DAY', 'a day that does not exist');
    expectError(await post({ time: '25:00' }), 400, 'INVALID_TIME', 'not a time');
    expectError(await post({ pictureId: '00000000000000000000000000000000' }), 400, 'PICTURE_NOT_FOUND', 'unknown picture');
    expectError(await post({ pictureId: undefined }), 400, 'PICTURE_REQUIRED', 'no picture');
    expectError(await post({ channels: ['instagram:999'] }), 400, 'CHANNEL_NOT_CONNECTED', 'channel not connected');
    expectError(await post({ channels: 'linkedin' }), 400, 'INVALID_CHANNELS', 'channels not a list');
    expectError(await post({ channels: [] }), 400, 'INVALID_CHANNELS', 'no channel chosen');
    expectError(await post({ caption: '' }), 400, 'CAPTION_REQUIRED', 'empty caption');
    expectError(await post({ caption: 'a'.repeat(5000) }), 400, 'CAPTION_TOO_LONG', 'caption too long');
    expectError(await post({ caption: Array.from({ length: 60 }, (_, i) => `#t${i}`).join(' ') }), 400, 'TOO_MANY_HASHTAGS', 'too many hashtags');
    expectError(await post({ variants: { twitter: { caption: 'x' } } }), 400, 'INVALID_VARIANTS', 'variant for a platform that does not exist');
    expectError(await post({ variants: 'linkedin' }), 400, 'INVALID_VARIANTS', 'variants not an object');
    expectError(await call(postsGet, '/api/v1/posts?externalId=shop-1&from=yesterday'), 400, 'INVALID_DAY', 'from is not a day');
  });
});

test('editing, deleting and sending a post that is not there, is on its way or has gone out each carry their own code', async () => {
  await withProduct(async () => {
    const { brand, pictureId, channelId } = await workspaceWithAccount();
    const made = await call(postsPost, '/api/v1/posts', { json: { externalId: 'shop-1', day: istDay(3), time: '11:30', caption: 'Fresh laddoos.', pictureId, channels: [channelId] } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const postId = String((made.body['post'] as { id: string }).id);
    const edit = (id: string, json: Record<string, unknown>): Promise<Answer> => call(postsPatch, `/api/v1/posts?externalId=shop-1&postId=${id}`, { method: 'PATCH', json });
    const remove = (id: string): Promise<Answer> => call(postsDelete, `/api/v1/posts?externalId=shop-1&postId=${id}`, { method: 'DELETE' });
    const send = (id: string): Promise<Answer> => call(sendNow, '/api/v1/send', { json: { externalId: 'shop-1', postId: id } });

    expectError(await edit('manual-000000000000', { caption: 'x' }), 404, 'POST_NOT_FOUND', 'edit a post that is not there');
    expectError(await remove('manual-000000000000'), 404, 'POST_NOT_FOUND', 'delete a post that is not there');
    expectError(await send('manual-000000000000'), 404, 'POST_NOT_FOUND', 'send a post that is not there');
    expectError(await edit(postId, {}), 400, 'NOTHING_TO_CHANGE', 'an edit that changes nothing');

    // Paused, skipped and gone out are what the post is, so sending says why it is not being sent.
    await savePauses({ all: false, brands: [brand], channels: [] }, null);
    expectError(await send(postId), 409, 'PAUSED', 'send while paused');
    await savePauses({ all: false, brands: [], channels: [] }, (await import('./store.ts').then((m) => m.loadPauses())).etag);
    const posted = await loadPosted();
    await savePosted({ ...posted.log, [postedKey(postId, channelId)]: { remoteId: 'held', permalink: null, postedAt: new Date().toISOString(), skipped: true } }, posted.etag);
    expectError(await send(postId), 409, 'POST_SKIPPED', 'send a skipped post');
    const again = await loadPosted();
    await savePosted({ ...again.log, [postedKey(postId, channelId)]: { remoteId: 'li-1', permalink: 'https://example.test/p/1', postedAt: new Date().toISOString() } }, again.etag);
    expectError(await send(postId), 409, 'POST_ALREADY_SENT', 'send a post that has gone out');

    // Sending dates a post now, so a post that has gone out (or whose time has come) is no longer editable or removable.
    const manual = await loadManual();
    await saveManual({ ...manual.file, posts: manual.file.posts.map((p) => (p.id === postId ? { ...p, date: new Date(Date.now() - 3600_000).toISOString().replace('Z', '+00:00') } : p)) }, manual.etag);
    expectError(await edit(postId, { caption: 'too late' }), 409, 'POST_NOT_EDITABLE', 'edit a post that has gone out');
    expectError(await remove(postId), 409, 'POST_NOT_EDITABLE', 'delete a post that has gone out');
    const final = await loadPosted();
    const cleared = { ...final.log };
    delete cleared[postedKey(postId, channelId)];
    await savePosted(cleared, final.etag);
    expectError(await edit(postId, { caption: 'too late' }), 409, 'POST_NOT_EDITABLE', 'edit a post that is due');
  });
});

test('a send that a channel could not take answers failed with a code and a plain sentence, and none of the raw error', async () => {
  await withProduct(async () => {
    // The pictures live at an address nothing listens on, so the channel's attempt really fails.
    process.env['PUBLIC_ORIGIN'] = 'http://127.0.0.1:1';
    const warned = console.warn;
    console.warn = (): void => undefined;
    try {
      const { pictureId, channelId } = await workspaceWithAccount();
      const made = await call(postsPost, '/api/v1/posts', { json: { externalId: 'shop-1', day: istDay(3), time: '11:30', caption: 'Fresh laddoos.', pictureId, channels: [channelId] } });
      const postId = String((made.body['post'] as { id: string }).id);
      const sent = await call(sendNow, '/api/v1/send', { json: { externalId: 'shop-1', postId } });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(sent.body['failed'], true);
      assert.deepEqual(sent.body['problems'], [{ account: 'Test Member', code: 'CHANNEL_UNREACHABLE', error: 'Test Member could not be reached just now. It will be tried again.' }]);
      assert.doesNotMatch(JSON.stringify(sent.body['problems']), /fetch failed|127\.0\.0\.1|ECONN/, 'the channel\'s own words are not passed on');
      assert.equal((sent.body['post'] as { state: string }).state, 'due', 'the post stays due so it is tried again');
    } finally {
      console.warn = warned;
    }
  });
});

test('a send to an account whose connection has run out says it must be connected again', async () => {
  await withProduct(async () => {
    process.env['PUBLIC_ORIGIN'] = 'http://127.0.0.1:1';
    const warned = console.warn;
    console.warn = (): void => undefined;
    try {
      // Connected an hour ago for a minute: the connection ended long ago.
      const { pictureId, channelId } = await workspaceWithAccount(60);
      const made = await call(postsPost, '/api/v1/posts', { json: { externalId: 'shop-1', day: istDay(3), time: '11:30', caption: 'Fresh laddoos.', pictureId, channels: [channelId] } });
      const postId = String((made.body['post'] as { id: string }).id);
      const sent = await call(sendNow, '/api/v1/send', { json: { externalId: 'shop-1', postId } });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.equal(sent.body['failed'], true);
      assert.deepEqual(sent.body['problems'], [{ account: 'Test Member', code: 'RECONNECT_NEEDED', error: 'Test Member needs to be connected again.' }]);
    } finally {
      console.warn = warned;
    }
  });
});
