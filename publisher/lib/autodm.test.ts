import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  addAutoDmRule,
  deleteAutoDmRule,
  keywordMatches,
  matchAutoDmRule,
  parseAutoDmFile,
  parseInstagramCommentEvents,
  parseInstagramPostbackEvents,
  ruleIdFromPayload,
  updateAutoDmRule,
  verifyMetaSignature,
} from './autodm.ts';

test('keywordMatches matches whole words/phrases case-insensitively and handles comma-separated lists', () => {
  assert.equal(keywordMatches('LINK, PRICE', 'Can you send the link please?'), true);
  assert.equal(keywordMatches('LINK, PRICE', 'What is the price!'), true);
  assert.equal(keywordMatches('LINK', 'I am linking this'), false);
  assert.equal(keywordMatches('send info', 'Please SEND INFO now'), true);
});

test('addAutoDmRule, updateAutoDmRule, deleteAutoDmRule round-trip through parseAutoDmFile', () => {
  const now = Date.parse('2026-11-28T10:00:00Z');
  const { file: f1, rule } = addAutoDmRule({ rules: [] }, 'acme', { keyword: 'LINK', message: 'Here is https://example.com' }, now);
  assert.equal(f1.rules.length, 1);
  assert.equal(rule.enabled, true);

  const parsed = parseAutoDmFile(JSON.parse(JSON.stringify(f1)));
  assert.equal(parsed.rules[0]?.keyword, 'LINK');

  const { file: f2, rule: updated } = updateAutoDmRule(parsed, rule.id, { enabled: false, mediaId: '12345' }, now + 1000);
  assert.equal(updated.enabled, false);
  assert.equal(updated.mediaId, '12345');

  const { file: f3, removed } = deleteAutoDmRule(f2, rule.id);
  assert.equal(removed, true);
  assert.equal(f3.rules.length, 0);
});

test('matchAutoDmRule prefers post-specific rules over account-wide rules and skips disabled rules', () => {
  const now = Date.parse('2026-11-28T10:00:00Z');
  let file = { rules: [] as ReturnType<typeof addAutoDmRule>['rule'][] };
  file = addAutoDmRule(file, 'acme', { keyword: 'LINK', message: 'Global link' }, now).file;
  file = addAutoDmRule(file, 'acme', { keyword: 'LINK', message: 'Post 99 link', mediaId: '99' }, now).file;
  file = addAutoDmRule(file, 'acme', { keyword: 'OFF', message: 'Disabled', enabled: false }, now).file;

  assert.equal(matchAutoDmRule(file.rules, 'acme', 'link please', '99')?.message, 'Post 99 link');
  assert.equal(matchAutoDmRule(file.rules, 'acme', 'link please', '100')?.message, 'Global link');
  assert.equal(matchAutoDmRule(file.rules, 'acme', 'off please', '100'), null);
  assert.equal(matchAutoDmRule(file.rules, 'other', 'link please', '99'), null);
});

test('verifyMetaSignature checks X-Hub-Signature-256 with timingSafeEqual', () => {
  const body = '{"object":"instagram"}';
  const secret = 'my_app_secret';
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, sig, secret), true);
  assert.equal(verifyMetaSignature(body, `${sig.slice(0, -1)}0`, secret), false);
  assert.equal(verifyMetaSignature(body, null, secret), false);
});

test('parseInstagramCommentEvents extracts comment webhook events and ignores non-comment changes', () => {
  const events = parseInstagramCommentEvents({
    object: 'instagram',
    entry: [
      {
        id: '17841400000000',
        changes: [
          {
            field: 'comments',
            value: {
              id: 'comment_1',
              text: 'LINK',
              from: { id: 'user_2', username: 'alice' },
              media: { id: 'media_9' },
            },
          },
          {
            field: 'mentions',
            value: { id: 'm1' },
          },
        ],
      },
    ],
  });
  assert.deepEqual(events, [
    {
      accountId: '17841400000000',
      commentId: 'comment_1',
      text: 'LINK',
      fromId: 'user_2',
      fromUsername: 'alice',
      mediaId: 'media_9',
    },
  ]);
});

test('requireFollow persists across round-trips and parseInstagramPostbackEvents extracts AUTODM payloads', () => {
  const now = Date.parse('2026-11-28T10:00:00Z');
  const { file, rule } = addAutoDmRule({ rules: [] }, 'acme', { keyword: 'LINK', message: 'https://example.com', requireFollow: true }, now);
  const parsed = parseAutoDmFile(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.rules[0]?.requireFollow, true);

  const events = parseInstagramPostbackEvents({
    object: 'instagram',
    entry: [
      {
        id: 'ig_biz_1',
        messaging: [
          {
            sender: { id: 'viewer_1' },
            postback: { payload: `AUTODM:${rule.id}` },
          },
          {
            sender: { id: 'ig_biz_1' },
            postback: { payload: `AUTODM:${rule.id}` },
          },
          {
            sender: { id: 'viewer_2' },
            message: { quick_reply: { payload: 'OTHER:123' } },
          },
        ],
      },
    ],
  });
  assert.deepEqual(events, [{ accountId: 'ig_biz_1', senderId: 'viewer_1', payload: `AUTODM:${rule.id}` }]);
  assert.equal(ruleIdFromPayload(events[0]!.payload), rule.id);
});
