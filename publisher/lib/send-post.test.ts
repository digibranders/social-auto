import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { addLinkedInMember, postedKey } from './channels.ts';
import { parseKey } from './crypto.ts';
import { sendPost } from './send-post.ts';
import type { ScheduledPost } from './schedule.ts';
import { loadPosted, saveChannels } from './store.ts';

const HEX_KEY = '22'.repeat(32);

/** Runs with a throwaway local store, no alert topic and a channel key, and puts the environment back afterwards. */
async function withLocalStore(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'send-post-test-'));
  const names = ['LOCAL_STORE_DIR', 'BLOB_READ_WRITE_TOKEN', 'CHANNEL_KEY', 'ALERT_NTFY_TOPIC'] as const;
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env['LOCAL_STORE_DIR'] = dir;
  process.env['CHANNEL_KEY'] = HEX_KEY;
  delete process.env['BLOB_READ_WRITE_TOKEN'];
  delete process.env['ALERT_NTFY_TOPIC'];
  const warn = console.warn;
  console.warn = (): void => undefined;
  try {
    await run();
  } finally {
    console.warn = warn;
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const planPost = (channels: string[]): ScheduledPost => ({
  brand: 'acme',
  id: 'acme-w01-d1',
  date: '2026-11-11T10:00:00+05:30',
  caption: 'A caption',
  image: '/posts/acme-w01-d1.jpg',
  fromPlan: true,
  channels,
});

test('a post naming an account that is gone is held, recorded once, and never sent anywhere else', async () => {
  await withLocalStore(async () => {
    // Another LinkedIn account of the same client is connected, so the post must not be sent there in place of the one it names.
    const other = addLinkedInMember({ channels: [] }, 'acme', { urn: 'urn:li:person:other', name: 'Other' }, 'token', 3600, parseKey(HEX_KEY), Date.parse('2026-11-01T00:00:00Z'));
    await saveChannels(other, null);

    const outcome = await sendPost(planPost(['linkedin:gone']), 'https://example.test', false);
    assert.equal(outcome.linkedin.length, 1);
    assert.equal(outcome.linkedin[0]?.status, 'held');
    assert.match(outcome.linkedin[0]?.error ?? '', /ACCOUNT_DISCONNECTED/);

    const { log } = await loadPosted();
    assert.equal(log[postedKey('acme-w01-d1', 'linkedin:gone')]?.reason, 'ACCOUNT_DISCONNECTED');
    assert.equal(log[postedKey('acme-w01-d1', 'linkedin:gone')]?.skipped, true);
    assert.equal(log[postedKey('acme-w01-d1', 'linkedin:other')], undefined);
  });
});

test('a post naming an account is checked even when nothing at all is connected on that platform', async () => {
  await withLocalStore(async () => {
    await saveChannels({ channels: [] }, null);
    const outcome = await sendPost(planPost(['facebook:gone']), 'https://example.test', false);
    assert.equal(outcome.facebook.length, 1);
    assert.equal(outcome.facebook[0]?.status, 'held');
    assert.equal((await loadPosted()).log[postedKey('acme-w01-d1', 'facebook:gone')]?.reason, 'ACCOUNT_DISCONNECTED');
  });
});

test('a post that names no account on a platform with nothing connected still does nothing there', async () => {
  await withLocalStore(async () => {
    await saveChannels({ channels: [] }, null);
    const outcome = await sendPost(planPost(['linkedin:gone']), 'https://example.test', false);
    assert.deepEqual(outcome.facebook, []);
    assert.deepEqual(outcome.google, []);
  });
});

test('a dry run records nothing for a gone account', async () => {
  await withLocalStore(async () => {
    await saveChannels({ channels: [] }, null);
    await sendPost(planPost(['facebook:gone']), 'https://example.test', true);
    assert.deepEqual((await loadPosted()).log, {});
  });
});

test('a carousel for the team\'s Instagram account is prepared as one container, and a dry run publishes nothing', async () => {
  const log: string[] = [];
  let n = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('media_publish')) { log.push('PUBLISHED'); return Response.json({ id: 'media1' }); }
    if (init?.method === 'POST' && url.endsWith('/media')) {
      const form = new URLSearchParams(String(init.body));
      n += 1;
      log.push(form.get('media_type') === 'CAROUSEL' ? `carousel(${form.get('children')})` : `item(${form.get('image_url')})`);
      return Response.json({ id: `c${n}` });
    }
    if (url.includes('fields=status_code')) return Response.json({ status_code: 'FINISHED' });
    return Response.json({ data: [] });
  });
  const before = { token: process.env['INSTAGRAM_TOKEN'], user: process.env['INSTAGRAM_USER_ID'] };
  process.env['INSTAGRAM_TOKEN'] = 'ig-token';
  process.env['INSTAGRAM_USER_ID'] = '9';
  try {
    await withLocalStore(async () => {
      const post: ScheduledPost = { brand: 'acme', id: 'c1', date: '2026-11-11T10:00:00+05:30', caption: 'Words.', image: '/posts/acme/1.jpg', images: ['/posts/acme/1.jpg', '/posts/acme/2.jpg', '/posts/acme/3.jpg'] };
      const outcome = await sendPost(post, 'https://pub.example', true);
      assert.equal(outcome.instagram['status'], 'dry-run-ready');
      assert.equal(outcome.instagram['container'], 'c4');
    });
  } finally {
    fetchMock.mock.restore();
    if (before.token === undefined) delete process.env['INSTAGRAM_TOKEN']; else process.env['INSTAGRAM_TOKEN'] = before.token;
    if (before.user === undefined) delete process.env['INSTAGRAM_USER_ID']; else process.env['INSTAGRAM_USER_ID'] = before.user;
  }
  assert.deepEqual(log, ['item(https://pub.example/posts/acme/1.jpg)', 'item(https://pub.example/posts/acme/2.jpg)', 'item(https://pub.example/posts/acme/3.jpg)', 'carousel(c1,c2,c3)']);
});
