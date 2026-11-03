import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeCaption, ContentValidationError, escapeHtml, parseHeadline, parseWeekPlan } from './content.ts';
import { headlineFontSize } from './layout.ts';
import { seedFromId } from './pollinations.ts';

const validPost = {
  id: 'p1',
  date: '2026-10-29T10:00:00+05:30',
  painPoint: 'pain',
  mode: 'template',
  headline: 'Plain |accent|',
  subline: 'sub',
  caption: 'Body',
  hashtags: ['#one', '#two'],
};

function plan(posts: unknown[]): unknown {
  return { brand: 'b', timezone: 'Asia/Kolkata', posts };
}

test('parseHeadline marks text between pipes as accent', () => {
  assert.deepEqual(parseHeadline('Your Instagram is |not on Google.|'), [
    { text: 'Your Instagram is ', accent: false },
    { text: 'not on Google.', accent: true },
  ]);
});

test('parseWeekPlan accepts a valid plan', () => {
  const parsed = parseWeekPlan(plan([validPost]), 'test');
  assert.equal(parsed.posts[0]?.id, 'p1');
});

test('parseWeekPlan rejects dates without a timezone offset', () => {
  assert.throws(() => parseWeekPlan(plan([{ ...validPost, date: '2026-10-29T10:00:00' }]), 'test'), ContentValidationError);
});

test('parseWeekPlan requires an image prompt for ai posts', () => {
  assert.throws(() => parseWeekPlan(plan([{ ...validPost, mode: 'ai' }]), 'test'), /imagePrompt/);
});

test('parseWeekPlan rejects duplicate ids and bad hashtags', () => {
  assert.throws(() => parseWeekPlan(plan([validPost, validPost]), 'test'), /unique/);
  assert.throws(() => parseWeekPlan(plan([{ ...validPost, hashtags: ['no-hash'] }]), 'test'), /hashtags/);
});

test('parseWeekPlan enforces the Instagram caption limit', () => {
  assert.throws(() => parseWeekPlan(plan([{ ...validPost, caption: 'x'.repeat(2200) }]), 'test'), /2200/);
});

test('composeCaption appends hashtags after a blank line', () => {
  assert.equal(composeCaption({ caption: 'Body ', hashtags: ['#a', '#b'] }), 'Body\n\n#a #b');
});

test('headlineFontSize steps down for long headlines but never below 56px', () => {
  const short = parseWeekPlan(plan([validPost]), 't').posts[0]!;
  assert.equal(headlineFontSize(short), 84);
  const long = { ...short, headline: 'WhatsApp talks to customers. |A website finds new ones.|' };
  assert.ok(headlineFontSize(long) < 84 && headlineFontSize(long) >= 56);
});

test('escapeHtml and seedFromId are safe and stable', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(seedFromId('w01-d1'), seedFromId('w01-d1'));
  assert.ok(seedFromId('w01-d1') >= 0);
});

test('a planned post may carry its pillar, which must be text', () => {
  const base = { id: 'w01-d1', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: 'template', headline: 'h', subline: 's', caption: 'c', hashtags: ['#a'] };
  const plan = (post: object) => ({ brand: 'acme', timezone: '+05:30', posts: [post] });
  assert.equal(parseWeekPlan(plan({ ...base, pillar: ' proof ' }), 'w').posts[0]?.pillar, 'proof');
  assert.equal(parseWeekPlan(plan(base), 'w').posts[0]?.pillar, undefined);
  assert.throws(() => parseWeekPlan(plan({ ...base, pillar: 3 }), 'w'), /pillar/);
  assert.throws(() => parseWeekPlan(plan({ ...base, pillar: '  ' }), 'w'), /pillar/);
});

test('a planned post may carry its hook, the hook that was requested, warnings and list items, all as text', () => {
  const base = { id: 'w01-d1', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: 'template', headline: 'h', subline: 's', caption: 'c', hashtags: ['#a'] };
  const plan = (post: object) => ({ brand: 'acme', timezone: '+05:30', posts: [post] });
  const full = { ...base, hook: 'direct_statement', requestedHook: 'question', hookWarnings: ['opening: x'], listItems: ['a', 'b'] };
  const post = parseWeekPlan(plan(full), 'w').posts[0];
  assert.equal(post?.hook, 'direct_statement');
  assert.equal(post?.requestedHook, 'question');
  assert.deepEqual(post?.hookWarnings, ['opening: x']);
  assert.deepEqual(post?.listItems, ['a', 'b']);
  assert.equal(parseWeekPlan(plan(base), 'w').posts[0]?.hook, undefined);
  assert.throws(() => parseWeekPlan(plan({ ...base, hook: ' ' }), 'w'), /hook/);
  assert.throws(() => parseWeekPlan(plan({ ...base, listItems: 'a' }), 'w'), /listItems/);
});
