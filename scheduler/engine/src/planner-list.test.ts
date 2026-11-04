import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HookError } from './hooks.ts';
import { validateDraft } from './planner.ts';

const PROOF = ['Free first visit for new patients'];
const draft = (over: Record<string, unknown> = {}) => ({
  headline: '3 ways to |plan| your week', subline: 'Acme Dental can help', caption: 'Plan your week with these.', hashtags: [], painPoint: 'p', visual: 'v', visualLink: 'l',
  listItems: ['Missed visits', 'Late reminders', 'Full waiting room'], ...over,
}) as never;
const check = (d: unknown, hook = 'numbered_list'): void => validateDraft(d as never, 1, 'Acme Dental', PROOF, { pillar: 'problem', hook } as never);

test('the leading count of a numbered-list headline is an editorial list size: it passes the gate when it matches the list items', () => {
  assert.doesNotThrow(() => check(draft()));
  assert.doesNotThrow(() => check(draft({ headline: '2 |parts| of an answer', listItems: ['The source', 'The reply'] })));
  assert.doesNotThrow(() => check(draft({ headline: '2 points about |answers|', listItems: ['The source', 'The reply'] })));
});

test('a count that does not match the list items is still turned back as a hook error', () => {
  assert.throws(() => check(draft({ listItems: ['Missed visits', 'Late reminders'] })), HookError);
});

test('only the leading headline count is exempt: it is not carried into the subline or caption, and other figures are gated', () => {
  assert.throws(() => check(draft({ headline: '3 |parts| of a plan', caption: 'Here are 3 parts of it.' })), /3/);
  assert.throws(() => check(draft({ subline: 'Acme Dental: 90 minutes saved' })), /90/);
  assert.throws(() => check(draft({ headline: '3 ways to save |40%|' })), /40/);
  assert.throws(() => check(draft({ caption: 'Get 14 days free.' })), /14/);
});

test('a leading number that is a quantity, not a list size, is gated', () => {
  assert.throws(() => check(draft({ headline: '2 million teams use |Acme|', listItems: ['One', 'Two'] })), /2/);
  assert.throws(() => check(draft({ headline: '3 |%| of weeks slip', listItems: ['One', 'Two', 'Three'] })));
});

test('the same number outside a numbered list is still gated', () => {
  assert.throws(() => check(draft({ headline: '2 parts of an |answer|', listItems: undefined }), 'direct_statement'), /2/);
});
