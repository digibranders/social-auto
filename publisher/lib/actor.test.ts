import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActorError, actorOf, reviewerName } from './actor.ts';

const requestWith = (headers: Record<string, string>): Request => new Request('https://social.example.test/api/v1/x', { method: 'POST', headers });

test('the person behind a call comes from the X-Social-Actor header', () => {
  assert.equal(actorOf(requestWith({ 'x-social-actor': 'user_123' })), 'user_123');
  assert.equal(actorOf(requestWith({ 'X-Social-Actor': ' 9f2c1a7e-4b3d-4e1a-8d6c-0a1b2c3d4e5f ' })), '9f2c1a7e-4b3d-4e1a-8d6c-0a1b2c3d4e5f', 'spaces around it are ignored');
  assert.equal(actorOf(requestWith({ 'x-social-actor': 'a.b:c-d_e' })), 'a.b:c-d_e');
  assert.equal(actorOf(requestWith({ 'x-social-actor': 'a'.repeat(64) })), 'a'.repeat(64));
});

test('a call without a person, or with a malformed one, is refused with its own code', () => {
  const refusal = (headers: Record<string, string>): ActorError => {
    try {
      actorOf(requestWith(headers));
    } catch (error) {
      assert.ok(error instanceof ActorError, String(error));
      return error;
    }
    return assert.fail('not refused');
  };
  assert.equal(refusal({}).code, 'ACTOR_REQUIRED');
  assert.equal(refusal({ 'x-social-actor': '   ' }).code, 'ACTOR_REQUIRED');
  for (const bad of ['a'.repeat(65), 'has space', 'semi;colon', 'quote"', 'ünï', 'slash/slash']) assert.equal(refusal({ 'x-social-actor': bad }).code, 'INVALID_ACTOR', JSON.stringify(bad));
  assert.equal(refusal({}).status, 400);
});

test('the X-Actor the engine records says which product and which person, and never runs over the engine\'s limit or uses a character it refuses', () => {
  const ENGINE_ACTOR = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,79}$/;
  assert.equal(reviewerName('brandbasket', 'user_123'), 'brandbasket:user_123');
  const longest = reviewerName('abcdefghijklmnopqrst', 'x'.repeat(64));
  assert.ok(longest.length <= 80, String(longest.length));
  assert.ok(longest.startsWith('abcdefghijklmnopqrst:'));
  assert.match(longest, ENGINE_ACTOR);
  // Two different long ids that begin the same still get different names, and the same id always gets the same name.
  const one = reviewerName('abcdefghijklmnopqrst', 'x'.repeat(63) + 'a');
  const two = reviewerName('abcdefghijklmnopqrst', 'x'.repeat(63) + 'b');
  assert.notEqual(one, two);
  assert.equal(one, reviewerName('abcdefghijklmnopqrst', 'x'.repeat(63) + 'a'));
  assert.ok(one.length <= 80 && two.length <= 80);
  assert.match(one, ENGINE_ACTOR);
});
