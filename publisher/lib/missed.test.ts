import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFacebookPages, postedKey, type PostedLog } from './channels.ts';
import { parseKey } from './crypto.ts';
import { findMissed, missedMessage, NO_ALERTS, parseAlertLog, unannounced, withAnnounced } from './missed.ts';
import { NO_PAUSES } from './pauses.ts';

const KEY = parseKey('11'.repeat(32));
const T0 = Date.parse('2026-10-01T00:00:00Z');
const channels = addFacebookPages({ channels: [] }, 'brandbasket', [{ id: '77', name: 'Brandbs', accessToken: 'page-token' }], KEY, T0);
const NOW = Date.parse('2026-11-05T12:00:00Z');
const H = 3_600_000;
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * H).toISOString();
const post = (id: string, hoursAgo: number, over: Record<string, unknown> = {}) => ({ id, brand: 'brandbasket', date: at(hoursAgo), caption: 'c', image: '/posts/x.jpg', ...over });

test('a post whose window passed without going out is missed; one that went out, is still due, is far in the past, is skipped or is ahead is not', () => {
  const log: PostedLog = { [postedKey('sent', 'facebook:77')]: { remoteId: 'r', permalink: 'https://f/b', postedAt: 'x' } };
  const found = findMissed([post('lost', 30), post('sent', 30), post('due', 5), post('old', 100), post('skip', 30, { skipped: true }), post('ahead', -5)], channels, log, NO_PAUSES, NOW);
  assert.deepEqual(found.map((m) => m.key), ['lost|facebook:77']);
  assert.equal(found[0]?.account, 'Brandbs');
});

test('a hand-made post with its own short window is missed soon after, a paused client or channel is not reported, and a channel connected later is not blamed', () => {
  assert.deepEqual(findMissed([post('own', 2, { manual: true })], channels, {}, NO_PAUSES, NOW).map((m) => m.key), ['own|facebook:77']);
  assert.deepEqual(findMissed([post('lost', 30)], channels, {}, { ...NO_PAUSES, brands: ['brandbasket'] }, NOW), []);
  assert.deepEqual(findMissed([post('lost', 30)], channels, {}, { ...NO_PAUSES, channels: ['facebook:77'] }, NOW), []);
  assert.deepEqual(findMissed([post('lost', 30)], channels, {}, { ...NO_PAUSES, all: true }, NOW), []);
  const late = addFacebookPages({ channels: [] }, 'brandbasket', [{ id: '77', name: 'Brandbs', accessToken: 't' }], KEY, NOW - 2 * H);
  assert.deepEqual(findMissed([post('lost', 30)], late, {}, NO_PAUSES, NOW), []);
});

test('a post is announced once: the log remembers it, forgets old entries, and keeps only what was delivered', () => {
  const missed = findMissed([post('a', 30), post('b', 31)], channels, {}, NO_PAUSES, NOW);
  assert.equal(unannounced(missed, NO_ALERTS).length, 2);
  const first = withAnnounced(NO_ALERTS, missed.slice(0, 1), NOW);
  assert.deepEqual(unannounced(missed, first).map((m) => m.postId), ['b']);
  const old = { missed: { 'x|y': new Date(NOW - 90 * 24 * H).toISOString() } };
  assert.deepEqual(Object.keys(withAnnounced(old, missed, NOW).missed).sort(), ['a|facebook:77', 'b|facebook:77']);
});

test('the notice log is read strictly, and the message groups a client\'s posts', () => {
  assert.deepEqual(parseAlertLog({}), NO_ALERTS);
  assert.deepEqual(parseAlertLog({ missed: { 'a|b': '2026-11-01T00:00:00Z' } }), { missed: { 'a|b': '2026-11-01T00:00:00Z' } });
  assert.throws(() => parseAlertLog([]), /must be an object/);
  assert.throws(() => parseAlertLog({ missed: { k: 5 } }), /bad time/);
  const many = findMissed(Array.from({ length: 10 }, (_, i) => post(`p${i}`, 30 + i)), channels, {}, NO_PAUSES, NOW);
  const note = missedMessage('brandbasket', many);
  assert.equal(note.title, '10 posts were missed: brandbasket');
  assert.match(note.message, /and 2 more/);
  assert.equal(missedMessage('brandbasket', many.slice(0, 1)).title, 'A post was missed: brandbasket');
});
