import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addFacebookPages, postedKey, type PostedLog } from './channels.ts';
import { parseKey } from './crypto.ts';
import { DUPLICATE_WINDOW_MS, findDuplicate, fingerprintOf, normalizeCaption } from './duplicates.ts';
import { duplicateText, guardChannels } from './send-guards.ts';

const KEY = parseKey('11'.repeat(32));
const T0 = Date.parse('2026-10-01T00:00:00Z');
const channels = addFacebookPages({ channels: [] }, 'brandbasket', [{ id: '77', name: 'Brandbs', accessToken: 't' }, { id: '88', name: 'Second', accessToken: 't' }], KEY, T0);
const NOW = Date.parse('2026-11-05T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const sentAt = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();
const entry = (daysAgo: number, caption: string, extra: Record<string, unknown> = {}) => ({ remoteId: 'r', permalink: 'https://f/b', postedAt: sentAt(daysAgo), fingerprint: fingerprintOf(caption), ...extra });
const post = (over: Record<string, unknown> = {}) => ({ id: 'new', brand: 'brandbasket', date: sentAt(0), caption: 'Big sale this Friday', ...over });

test('the same words with other spacing or capitals are the same caption, and different words are not', () => {
  assert.equal(normalizeCaption('  Big   SALE\nthis Friday '), 'big sale this friday');
  assert.equal(fingerprintOf('Big sale this Friday'), fingerprintOf('big  sale this friday '));
  assert.notEqual(fingerprintOf('Big sale this Friday'), fingerprintOf('Big sale this Saturday'));
});

test('an earlier post with the same words on the same channel within a week is a duplicate; others are not', () => {
  const log: PostedLog = {
    [postedKey('old', 'facebook:77')]: entry(2, 'Big sale this Friday'),
    [postedKey('other-words', 'facebook:88')]: entry(1, 'Something else'),
    [postedKey('too-old', 'facebook:88')]: entry(8, 'Big sale this Friday'),
    [postedKey('skipped', 'facebook:88')]: entry(1, 'Big sale this Friday', { skipped: true }),
    [postedKey('no-fingerprint', 'facebook:88')]: { remoteId: 'r', permalink: null, postedAt: sentAt(1) },
  };
  assert.equal(findDuplicate(log, 'facebook:77', 'new', 'big sale this friday', NOW)?.key, 'old|facebook:77');
  assert.equal(findDuplicate(log, 'facebook:88', 'new', 'Big sale this Friday', NOW), undefined, 'another channel, an older post, a skipped one and one with no fingerprint do not count');
  assert.equal(findDuplicate(log, 'facebook:77', 'old', 'Big sale this Friday', NOW), undefined, 'a post is never a duplicate of itself');
  assert.equal(DUPLICATE_WINDOW_MS, 7 * DAY);
});

test('guardChannels leaves out only the channel that already got the words, and keeps the other', () => {
  const log: PostedLog = { [postedKey('old', 'facebook:77')]: entry(2, 'Big sale this Friday') };
  const answer = guardChannels(channels, post(), 'facebook', log, NOW);
  assert.deepEqual(answer.duplicates.map((d) => d.channel.id), ['facebook:77']);
  assert.deepEqual(answer.gone, []);
  assert.match(duplicateText(answer.duplicates[0]!.channel, answer.duplicates[0]!.of), /Brandbs: not sent, because a post with the same words was already sent there on 2026-11-03/);
  assert.deepEqual(guardChannels(channels, post({ caption: 'A different caption' }), 'facebook', log, NOW).duplicates, []);
  assert.deepEqual(guardChannels(channels, post(), 'facebook', { ...log, [postedKey('new', 'facebook:77')]: entry(0, 'x') }, NOW).duplicates, [], 'a channel this post already has an entry for is the post log\'s business');
});

test('an exact account that is no longer connected is reported once, and a platform name or a connected account is not', () => {
  assert.deepEqual(guardChannels(channels, post({ channels: ['facebook:999', 'facebook:77', 'instagram', 'linkedin:abc'] }), 'facebook', {}, NOW).gone, ['facebook:999']);
  assert.deepEqual(guardChannels(channels, post({ channels: ['facebook:999'] }), 'linkedin', {}, NOW).gone, [], 'another platform\'s sender does not speak for it');
  assert.deepEqual(guardChannels(channels, post({ channels: ['facebook:999'] }), 'facebook', { [postedKey('new', 'facebook:999')]: { remoteId: 'account-disconnected', permalink: null, postedAt: sentAt(0), skipped: true } }, NOW).gone, [], 'already written down, so not reported again');
});
