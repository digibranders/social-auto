import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GET as inboxGet, POST as inboxPost } from '../api/inbox.ts';
import { GET as collectGet } from '../api/inbox-collect.ts';
import type { Channel } from './channels.ts';
import { encrypt, parseKey } from './crypto.ts';
import { addComments, EMPTY_INBOX } from './inbox.ts';
import { doInbox, listInbox, runInboxCheck, type InboxWriters } from './inbox-service.ts';
import { InboxWriteError } from './inbox-fetch.ts';
import { EditError } from './overrides.ts';
import { loadInbox, saveChannels, saveInbox } from './store.ts';

const KEY_HEX = '66'.repeat(32);
const NOW = Date.parse('2026-11-12T10:00:00Z');
const ig: Channel = { id: 'instagram:1', platform: 'instagram', brand: 'b', userId: '1', username: 'shop', token: encrypt('ig-token', parseKey(KEY_HEX)), expiresAt: '2027-01-01T00:00:00Z', connectedAt: '2026-10-01T00:00:00Z' };

async function withStore(run: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'inbox-'));
  const before = Object.fromEntries(['LOCAL_STORE_DIR', 'CHANNEL_KEY', 'STATUS_SECRET', 'EDIT_SECRET', 'CRON_SECRET', 'INBOX_ENABLED', 'BLOB_READ_WRITE_TOKEN'].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { LOCAL_STORE_DIR: dir, CHANNEL_KEY: KEY_HEX, STATUS_SECRET: 'status-secret-0123456789', EDIT_SECRET: 'edit-secret-0123456789', CRON_SECRET: 'cron-secret-0123456789' });
  delete process.env['INBOX_ENABLED'];
  delete process.env['BLOB_READ_WRITE_TOKEN'];
  const logged = console.error;
  console.error = (): void => undefined;
  try {
    await saveChannels({ channels: [ig] }, null);
    await saveInbox(addComments(EMPTY_INBOX, { brand: 'b', channel: 'instagram:1', platform: 'instagram', post: { id: 'p1', title: 'Diwali boxes', permalink: null } }, [{ remoteId: 'c1', author: 'priya', text: 'Is it available?', at: new Date(NOW - 3_600_000).toISOString() }], NOW), null);
    await run();
  } finally {
    console.error = logged;
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(dir, { recursive: true, force: true });
  }
}

const req = (path: string, init: { method?: string; secret?: string | null; json?: unknown } = {}): Request =>
  new Request(`https://social.example.test${path}`, { method: init.method ?? 'GET', headers: { ...(init.secret === null ? {} : { authorization: `Bearer ${init.secret ?? 'status-secret-0123456789'}` }), ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });

test('a reply is posted to the network with the saved token, then recorded; the message becomes done and shows who answered', async () => {
  await withStore(async () => {
    const calls: string[] = [];
    const writers: InboxWriters = { instagramReply: async (id, token, text) => { calls.push(`${id} ${token} ${text}`); return 'r1'; }, facebookReply: async () => { throw new Error('not expected'); } };
    await doInbox({ id: 'instagram:1|c1', action: 'reply', text: '  Yes, we deliver!  ' }, 'Asha', NOW, writers);
    assert.deepEqual(calls, ['c1 ig-token Yes, we deliver!']);
    const item = (await loadInbox()).file.items['instagram:1|c1'];
    assert.deepEqual([item?.status, item?.replies[0]?.by, item?.replies[0]?.remoteId], ['done', 'Asha', 'r1']);
  });
});

test('a reply the network refuses for a missing permission leaves the message as it was, says to connect again, and marks the account', async () => {
  await withStore(async () => {
    const writers: InboxWriters = { instagramReply: async () => { throw new InboxWriteError('permission', ''); }, facebookReply: async () => null };
    await assert.rejects(doInbox({ id: 'instagram:1|c1', action: 'reply', text: 'Hi' }, 'Asha', NOW, writers), (e: unknown) => e instanceof EditError && e.status === 409 && /Connect it again/.test(e.message));
    const { file } = await loadInbox();
    assert.equal(file.items['instagram:1|c1']?.status, 'todo');
    assert.equal(file.items['instagram:1|c1']?.replies.length, 0);
    assert.equal(file.channels['instagram:1']?.needs, 'reconnect');
  });
});

test('a failed post is an error and nothing is recorded; an empty reply is never sent', async () => {
  await withStore(async () => {
    let sent = 0;
    const writers: InboxWriters = { instagramReply: async () => { sent += 1; throw new InboxWriteError('failed', 'boom'); }, facebookReply: async () => null };
    await assert.rejects(doInbox({ id: 'instagram:1|c1', action: 'reply', text: 'Hi' }, 'Asha', NOW, writers), (e: unknown) => e instanceof EditError && e.status === 502);
    await assert.rejects(doInbox({ id: 'instagram:1|c1', action: 'reply', text: '   ' }, 'Asha', NOW, writers), /write a reply/);
    assert.equal(sent, 1);
    assert.equal((await loadInbox()).file.items['instagram:1|c1']?.replies.length, 0);
  });
});

test('the staff endpoints need their own secrets, list one brand, and change a message', async () => {
  await withStore(async () => {
    assert.equal((await inboxGet(req('/api/inbox?brand=b', { secret: null }))).status, 401);
    assert.equal((await inboxGet(req('/api/inbox?brand=b', { secret: 'edit-secret-0123456789' }))).status, 401, 'the write secret does not read');
    const list = (await (await inboxGet(req('/api/inbox?brand=b&status=todo'))).json()) as { enabled: boolean; items: Array<{ id: string; text: string }>; counts: { todo: number }; channels: Array<{ channel: string }> };
    assert.deepEqual([list.enabled, list.items.map((i) => i.id), list.counts.todo, list.channels.map((c) => c.channel)], [true, ['instagram:1|c1'], 1, ['instagram:1']]);
    assert.equal(((await (await inboxGet(req('/api/inbox?brand=other'))).json()) as { items: unknown[] }).items.length, 0, 'another brand sees nothing');
    assert.equal((await inboxGet(req('/api/inbox?brand=b&status=nope'))).status, 400);
    assert.equal((await inboxPost(req('/api/inbox', { method: 'POST', json: { id: 'instagram:1|c1', action: 'done', by: 'Asha' } }))).status, 401, 'the read secret does not write');
    const done = await inboxPost(req('/api/inbox', { method: 'POST', secret: 'edit-secret-0123456789', json: { id: 'instagram:1|c1', action: 'assign', assignee: 'Ravi', by: 'Asha' } }));
    assert.equal(done.status, 200);
    assert.equal((await loadInbox()).file.items['instagram:1|c1']?.assignee, 'Ravi');
    const bad = await inboxPost(req('/api/inbox', { method: 'POST', secret: 'edit-secret-0123456789', json: { id: 'nope', action: 'done', by: 'Asha' } }));
    assert.equal(bad.status, 404);
    assert.equal((await inboxPost(req('/api/inbox', { method: 'POST', secret: 'edit-secret-0123456789', json: { action: 'done' } }))).status, 400);
  });
});

test('the regular check needs the cron secret, reads nothing while switched off, and a real run with no posts finds nothing', async () => {
  await withStore(async () => {
    assert.equal((await collectGet(req('/api/inbox-collect', { secret: 'wrong' }))).status, 401);
    const ran = await runInboxCheck(NOW, { instagramComments: async () => ({ needs: null, comments: [] }), facebookComments: async () => ({ needs: null, comments: [] }) });
    assert.deepEqual([ran.posts, ran.comments], [0, 0]);
    process.env['INBOX_ENABLED'] = 'false';
    const off = (await (await collectGet(req('/api/inbox-collect', { secret: 'cron-secret-0123456789' }))).json()) as { skipped?: string };
    assert.match(off.skipped ?? '', /switched off/);
    assert.equal((await listInbox({ brand: 'b' })).enabled, false);
  });
});

test('a reply to a comment on the team Instagram account is posted with the team token from the settings', async () => {
  await withStore(async () => {
    const before = process.env['INSTAGRAM_TOKEN'];
    process.env['INSTAGRAM_TOKEN'] = 'team-env-token';
    try {
      await saveInbox(addComments((await loadInbox()).file, { brand: 'alsonotify', channel: 'instagram', platform: 'instagram', post: { id: 'manual-1', title: 'Hello', permalink: null } }, [{ remoteId: 't1', author: 'sam', text: 'Nice!', at: new Date(NOW - 60_000).toISOString() }], NOW), (await loadInbox()).etag);
      const calls: string[] = [];
      await doInbox({ id: 'instagram|t1', action: 'reply', text: 'Thanks!' }, 'Asha', NOW, { instagramReply: async (id, token, text) => { calls.push(`${id} ${token} ${text}`); return 'r9'; }, facebookReply: async () => null });
      assert.deepEqual(calls, ['t1 team-env-token Thanks!']);
      const view = await listInbox({ brand: 'alsonotify' });
      assert.deepEqual(view.channels.map((c) => [c.channel, c.label]), [['instagram', 'Instagram']], 'the team account shows as a channel of the client it posted for');
      assert.equal(view.items[0]?.status, 'done');
    } finally {
      if (before === undefined) delete process.env['INSTAGRAM_TOKEN'];
      else process.env['INSTAGRAM_TOKEN'] = before;
    }
  });
});
