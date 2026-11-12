import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Channel, PostedLog } from './channels.ts';
import { encrypt, parseKey } from './crypto.ts';
import { act, addComments, EMPTY_INBOX, forgetBrand, markChannel, parseInbox, tidy, validReply, viewInbox, MAX_REPLY, RETENTION_DAYS, type InboxFile } from './inbox.ts';
import { collectInbox, type InboxReaders } from './inbox-collect.ts';
import { EditError } from './overrides.ts';

const KEY = parseKey('55'.repeat(32));
const NOW = Date.parse('2026-11-12T10:00:00Z');
const DAY = 86_400_000;
const src = { brand: 'b', channel: 'instagram:1', platform: 'instagram' as const, post: { id: 'p1', title: 'Diwali boxes', permalink: 'https://ig/p/1' } };
const c = (id: string, text = 'Is it available?', daysAgo = 1, author = 'priya') => ({ remoteId: id, author, text, at: new Date(NOW - daysAgo * DAY).toISOString() });

test('a new comment starts as "to answer" and unread; a known one keeps what people did to it and only has its words refreshed', () => {
  let file = addComments(EMPTY_INBOX, src, [c('c1')], NOW);
  const item = file.items['instagram:1|c1'];
  assert.equal(item?.status, 'todo');
  assert.equal(item?.read, false);
  file = act(file, 'instagram:1|c1', { action: 'assign', assignee: 'Ravi' }, NOW);
  file = act(file, 'instagram:1|c1', { action: 'note', by: 'Ravi', text: 'regular' }, NOW);
  file = addComments(file, src, [c('c1', 'Is it available in Gurugram?')], NOW);
  assert.equal(file.items['instagram:1|c1']?.text, 'Is it available in Gurugram?');
  assert.equal(file.items['instagram:1|c1']?.assignee, 'Ravi');
  assert.equal(file.items['instagram:1|c1']?.notes.length, 1);
});

test('nothing older than the retention limit is added, and tidy drops it later', () => {
  const old = c('old', 'x', RETENTION_DAYS + 1);
  assert.deepEqual(Object.keys(addComments(EMPTY_INBOX, src, [old, c('new')], NOW).items), ['instagram:1|new']);
  const file = addComments(EMPTY_INBOX, src, [c('edge', 'x', RETENTION_DAYS - 1)], NOW);
  assert.equal(Object.keys(tidy(file, new Set(['instagram:1']), NOW + 2 * DAY).items).length, 0, 'it ages out two days later');
});

test('comments of an account that is no longer connected, and of a removed brand, are forgotten', () => {
  let file = addComments(EMPTY_INBOX, src, [c('a')], NOW);
  file = addComments(file, { ...src, brand: 'other', channel: 'instagram:2' }, [c('b')], NOW);
  assert.deepEqual(Object.keys(tidy(file, new Set(['instagram:2']), NOW).items), ['instagram:2|b']);
  assert.deepEqual(Object.keys(forgetBrand(file, 'b').items), ['instagram:2|b']);
});

test('answering marks it done and read and remembers the reply; done, reopen and read work; unknown items and bad values are refused', () => {
  let file = addComments(EMPTY_INBOX, src, [c('c1')], NOW);
  file = act(file, 'instagram:1|c1', { action: 'replied', by: 'Asha', text: 'Yes!', remoteId: 'r1' }, NOW);
  const item = file.items['instagram:1|c1'];
  assert.deepEqual([item?.status, item?.read, item?.replies[0]?.remoteId, item?.replies[0]?.text], ['done', true, 'r1', 'Yes!']);
  assert.equal(act(file, 'instagram:1|c1', { action: 'reopen' }, NOW).items['instagram:1|c1']?.status, 'todo');
  assert.throws(() => act(file, 'nope', { action: 'done' }, NOW), (e: unknown) => e instanceof EditError && e.status === 404);
  assert.throws(() => act(file, 'instagram:1|c1', { action: 'note', by: 'A', text: '   ' }, NOW), /write a note/);
  assert.throws(() => act(file, 'instagram:1|c1', { action: 'assign', assignee: 'x'.repeat(200) }, NOW), /short name/);
  assert.throws(() => validReply('   '), /write a reply/);
  assert.throws(() => validReply('x'.repeat(MAX_REPLY + 1)), /at most/);
  assert.equal(validReply('  hi  '), 'hi');
});

test('the view lists one brand\'s items newest first, filters them, and says which accounts must be connected again', () => {
  let file = addComments(EMPTY_INBOX, src, [c('c1', 'one', 3), c('c2', 'two', 1)], NOW);
  file = addComments(file, { ...src, brand: 'other', channel: 'instagram:9' }, [c('z')], NOW);
  file = act(file, 'instagram:1|c1', { action: 'done' }, NOW);
  file = markChannel(file, 'instagram:1', 'reconnect', NOW);
  const view = viewInbox(file, { brand: 'b', status: 'todo' }, [{ id: 'instagram:1', platform: 'instagram', label: 'shop' }, { id: 'linkedin:3', platform: 'linkedin', label: 'Asha' }]);
  assert.deepEqual(view.items.map((i) => i.remoteId), ['c2']);
  assert.deepEqual(view.counts, { todo: 1, done: 1, unread: 2 });
  assert.deepEqual(view.channels.map((x) => [x.channel, x.needs]), [['instagram:1', 'reconnect']], 'LinkedIn has no comments to read');
  assert.deepEqual(viewInbox(file, { brand: 'b', status: 'all', assignee: 'none' }).items.length, 2);
});

test('the file survives being saved and read back, and a malformed entry is refused', () => {
  const file = markChannel(addComments(EMPTY_INBOX, src, [c('c1')], NOW), 'instagram:1', null, NOW);
  assert.deepEqual(parseInbox(JSON.parse(JSON.stringify(file))), file);
  assert.throws(() => parseInbox({ items: { x: { brand: 1 } } }), /malformed/);
});

// ---- the check ---------------------------------------------------------------------------------------------------------------------------

const ig: Channel = { id: 'instagram:1', platform: 'instagram', brand: 'b', userId: '1', username: 'shop', token: encrypt('ig-token', KEY), expiresAt: '2027-01-01T00:00:00Z', connectedAt: '2026-10-01T00:00:00Z' };
const fb: Channel = { id: 'facebook:7', platform: 'facebook', brand: 'b', pageId: '7', pageName: 'Page', token: encrypt('fb-token', KEY), connectedAt: '2026-10-01T00:00:00Z' };
const posted = (ageDays: number, key = 'p1|instagram:1', extra = {}): PostedLog => ({ [key]: { remoteId: 'media1', permalink: 'https://ig/p/1', postedAt: new Date(NOW - ageDays * DAY).toISOString(), ...extra } });

function readers(calls: string[], over: Partial<InboxReaders> = {}): InboxReaders {
  return {
    instagramComments: async (id, token) => { calls.push(`ig ${id} ${token}`); return { needs: null, comments: [c('c1')] }; },
    facebookComments: async (id, page, token) => { calls.push(`fb ${id} ${page} ${token}`); return { needs: null, comments: [c('f1', 'nice', 1, 'anita')] }; },
    ...over,
  };
}

test('the check reads the comments on each recent post with the saved token and adds the new ones once', async () => {
  const calls: string[] = [];
  const log: PostedLog = { ...posted(2), ...posted(2, 'p2|facebook:7', { remoteId: '7_2' }) };
  const first = await collectInbox({ file: EMPTY_INBOX, channels: [ig, fb], posted: log, key: KEY, readers: readers(calls), now: NOW, titleOf: (id) => `Post ${id}` });
  assert.deepEqual(calls.sort(), ['fb 7_2 7 fb-token', 'ig media1 ig-token']);
  assert.deepEqual([first.report.posts, first.report.comments, first.report.failures], [2, 2, []]);
  assert.equal(first.file.items['instagram:1|c1']?.post.title, 'Post p1');
  const again = await collectInbox({ file: first.file, channels: [ig, fb], posted: log, key: KEY, readers: readers([]), now: NOW + 900_000 });
  assert.equal(again.report.comments, 0, 'the same comments are not added twice');
});

test('a post older than two weeks is read once a day, and one older than a month not at all', async () => {
  const first = await collectInbox({ file: EMPTY_INBOX, channels: [ig], posted: posted(20), key: KEY, readers: readers([]), now: NOW });
  const calls: string[] = [];
  await collectInbox({ file: first.file, channels: [ig], posted: posted(20), key: KEY, readers: readers(calls), now: NOW + 3_600_000 });
  assert.deepEqual(calls, [], 'already read today');
  await collectInbox({ file: first.file, channels: [ig], posted: posted(20), key: KEY, readers: readers(calls), now: NOW + DAY });
  assert.equal(calls.length, 1, 'read again the next day');
  const old = await collectInbox({ file: EMPTY_INBOX, channels: [ig], posted: posted(31), key: KEY, readers: readers([]), now: NOW });
  assert.equal(old.report.posts, 0);
});

test('posts that were held, repeated or dropped are never read', async () => {
  for (const extra of [{ skipped: true as const }, { duplicateOf: 'x|instagram:1' }, { reason: 'account-disconnected' }, { remoteId: 'held' }]) {
    const calls: string[] = [];
    await collectInbox({ file: EMPTY_INBOX, channels: [ig], posted: posted(1, 'p1|instagram:1', extra), key: KEY, readers: readers(calls), now: NOW });
    assert.deepEqual(calls, []);
  }
});

test('a refused account is marked "reconnect", probed with one post a check, and recovers when the permission is given', async () => {
  const log: PostedLog = { ...posted(1), ...posted(2, 'p2|instagram:1', { remoteId: 'media2' }) };
  const calls: string[] = [];
  const refuse = readers(calls, { instagramComments: async (id) => { calls.push(`ig ${id}`); return { needs: 'reconnect', comments: [] }; } });
  const first = await collectInbox({ file: EMPTY_INBOX, channels: [ig], posted: log, key: KEY, readers: refuse, now: NOW });
  assert.deepEqual(first.report.reconnect, ['instagram:1']);
  assert.equal(first.file.channels['instagram:1']?.needs, 'reconnect');
  assert.equal(calls.length, 1, 'the second post was not tried once the first was refused');
  calls.length = 0;
  await collectInbox({ file: first.file, channels: [ig], posted: log, key: KEY, readers: refuse, now: NOW + 900_000 });
  assert.equal(calls.length, 1, 'one probe per check');
  const fixed = await collectInbox({ file: first.file, channels: [ig], posted: log, key: KEY, readers: readers([]), now: NOW + 1_800_000 });
  assert.equal(fixed.file.channels['instagram:1']?.needs, undefined);
  assert.equal(fixed.report.comments, 1);
});

test('one failing post does not stop the others, and a disconnected account is forgotten', async () => {
  const stale: InboxFile = addComments(EMPTY_INBOX, { ...src, channel: 'instagram:gone' }, [c('old')], NOW);
  const log: PostedLog = { ...posted(1), ...posted(1, 'p2|facebook:7', { remoteId: '7_2' }) };
  const { file, report } = await collectInbox({ file: stale, channels: [ig, fb], posted: log, key: KEY, readers: readers([], { instagramComments: async () => { throw new Error('Instagram comments failed: boom'); } }), now: NOW });
  assert.deepEqual(report.failures, [{ id: 'p1|instagram:1', reason: 'Instagram comments failed: boom' }]);
  assert.equal(report.comments, 1);
  assert.equal(file.items['instagram:gone|old'], undefined);
});
