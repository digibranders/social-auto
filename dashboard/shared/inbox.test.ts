import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInbox } from './inbox.ts';

const answer = {
  enabled: true,
  checkedAt: '2026-11-12T08:00:00.000Z',
  counts: { todo: 2, done: 1, unread: -4 },
  channels: [{ channel: 'instagram:1', platform: 'instagram', label: 'shop', needs: 'reconnect', checkedAt: '2026-11-12T08:00:00.000Z' }, { channel: 'linkedin:3', platform: 'linkedin', label: 'Asha' }, 'odd'],
  items: [
    { id: 'instagram:1|c1', channel: 'instagram:1', platform: 'instagram', author: 'priya', text: 'Is it available?', at: '2026-11-12T07:00:00.000Z', post: { title: 'Diwali boxes', permalink: 'https://ig/p/1' }, status: 'done', assignee: 'Ravi', notes: [{ by: 'Ravi', text: 'regular', at: '2026-11-12T07:30:00.000Z' }, { text: 'no author' }], replies: [{ by: 'Asha', text: 'Yes!', at: '2026-11-12T07:40:00.000Z' }], read: true, secret: 'leak', token: 'x' },
    { id: 'x', channel: 'y', platform: 'myspace', at: 'x' },
    'odd',
  ],
};

test('a part that cannot be read is left out and the rest still shows, and nothing unknown is passed on', () => {
  const data = parseInbox(answer);
  assert.equal(data.items.length, 1);
  assert.deepEqual([data.items[0]?.status, data.items[0]?.assignee, data.items[0]?.notes.length, data.items[0]?.replies[0]?.text, data.items[0]?.read], ['done', 'Ravi', 1, 'Yes!', true]);
  assert.doesNotMatch(JSON.stringify(data), /leak|token/);
  assert.deepEqual(data.channels, [{ channel: 'instagram:1', platform: 'instagram', label: 'shop', needs: true, checkedAt: '2026-11-12T08:00:00.000Z' }], 'LinkedIn and odd rows are dropped');
  assert.deepEqual(data.counts, { todo: 2, done: 1, unread: 0 }, 'a negative count is not shown');
  assert.throws(() => parseInbox([]), /not an object/);
  assert.equal(parseInbox({}).enabled, false);
});
