import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignHooks, availableHooks, checkHook, defaultHooks, fallbackHeadline, normalizeHeadline, repetitionWarnings, type HookSpec } from './hooks.ts';

const PROOF = ['Free first visit for new patients'];
const evidence = { proofPoints: PROOF };
const week = (pillars: string[], over: { recentHooks?: string[]; recentPillars?: string[]; hooks?: readonly HookSpec[] } = {}) =>
  assignHooks({ pillars, evidence, recentHooks: over.recentHooks ?? [], recentPillars: over.recentPillars ?? [], ...(over.hooks ? { hooks: over.hooks } : {}) });
const PILLARS = ['problem', 'education', 'proof', 'offer', 'story', 'problem', 'education'];

test('hooks that need evidence the profile does not hold are never assigned: v1 rotates the five that need none', () => {
  assert.deepEqual(availableHooks(evidence).sort(), ['benefit_statement', 'contrast', 'direct_statement', 'numbered_list', 'question']);
  assert.ok(!availableHooks(evidence).includes('before_after'));
  assert.ok(availableHooks({ ...evidence, beforeAfter: true }).includes('before_after'));
  assert.ok(availableHooks({ ...evidence, steps: true }).includes('how_to'));
  assert.ok(availableHooks({ ...evidence, myths: true }).includes('myth_fact'));
});

test('a seven-post week uses at least three different hooks and never the same one twice in a row', () => {
  const hooks = week(PILLARS);
  assert.equal(hooks.length, 7);
  assert.ok(new Set(hooks).size >= 3, hooks.join(','));
  for (let i = 1; i < hooks.length; i++) assert.notEqual(hooks[i], hooks[i - 1]);
});

test('every hook is compatible with the pillar of its post', () => {
  const hooks = week(PILLARS);
  hooks.forEach((hook, i) => assert.ok(defaultHooks.find((h) => h.id === hook)?.compatible[PILLARS[i] as string] !== undefined, `${hook} for ${PILLARS[i]}`));
});

test('over a long run no eligible hook is starved', () => {
  let hooks: string[] = [];
  let pillars: string[] = [];
  for (let w = 0; w < 12; w++) {
    const p = PILLARS.slice(0, 5);
    hooks = [...hooks, ...week(p, { recentHooks: hooks, recentPillars: pillars })];
    pillars = [...pillars, ...p];
  }
  const counts = availableHooks(evidence).map((id) => hooks.filter((h) => h === id).length);
  assert.ok(Math.min(...counts) > 0, counts.join(','));
  assert.ok(Math.max(...counts) <= Math.min(...counts) * 3, counts.join(','));
});

test('with one eligible hook the week still schedules, repeating it', () => {
  const only: HookSpec[] = [{ id: 'direct_statement', brief: 'State one plain fact.', compatible: { problem: 'strong', education: 'strong' }, needs: null }];
  assert.deepEqual(week(['problem', 'education', 'problem'], { hooks: only }), ['direct_statement', 'direct_statement', 'direct_statement']);
});

test('weight zero disables a hook, and a heavier weight makes it come up more', () => {
  const off = defaultHooks.map((h) => (h.id === 'question' ? { ...h, weight: 0 } : h));
  assert.ok(!week(PILLARS, { hooks: off }).includes('question'));
  const heavy = defaultHooks.map((h) => (h.id === 'direct_statement' ? { ...h, weight: 3 } : h));
  const long = Array.from({ length: 20 }, (_, i) => PILLARS[i % PILLARS.length] as string);
  const count = (hooks: string[], id: string) => hooks.filter((h) => h === id).length;
  assert.ok(count(week(long, { hooks: heavy }), 'direct_statement') > count(week(long), 'direct_statement'));
});

test('a recent pillar-and-hook pairing is avoided when another hook would serve', () => {
  const first = week(['problem'], {})[0] as string;
  const again = week(['problem'], { recentHooks: [first], recentPillars: ['problem'] })[0];
  assert.notEqual(again, first);
});

test('two tenants with different settings schedule independently', () => {
  const a = week(PILLARS, { hooks: defaultHooks.filter((h) => h.id !== 'question') });
  const b = week(PILLARS);
  assert.ok(!a.includes('question'));
  assert.ok(b.includes('question'));
});

test('a question hook must end in a question mark, and a statement hook must not', () => {
  assert.equal(checkHook({ hook: 'question', headline: 'Is your |next visit| hard to book?' }), undefined);
  assert.match(checkHook({ hook: 'question', headline: 'Your next visit is hard to book' }) ?? '', /question/);
  assert.match(checkHook({ hook: 'direct_statement', headline: 'Is it hard to book?' }) ?? '', /statement/);
  assert.equal(checkHook({ hook: 'benefit_statement', headline: 'Book your visit in one tap' }), undefined);
});

test('accent markers do not interfere with checks', () => {
  assert.equal(normalizeHeadline('Is your |next visit| hard to book?'), 'is your next visit hard to book');
  assert.equal(checkHook({ hook: 'question', headline: '|Hard to book?|' }), undefined);
});

test('a numbered list needs a headline number that equals its distinct items, within the maximum', () => {
  const ok = { hook: 'numbered_list', headline: '3 signs your site is |losing visitors|', listItems: ['Pages load slowly', 'The menu is hard to find', 'There is no clear next step'] };
  assert.equal(checkHook(ok), undefined);
  assert.match(checkHook({ ...ok, listItems: ['Pages load slowly', 'The menu is hard to find'] }) ?? '', /3.*2|match/);
  assert.match(checkHook({ ...ok, listItems: ['Pages load slowly', 'pages load slowly!', 'No clear next step'] }) ?? '', /distinct/);
  assert.match(checkHook({ ...ok, listItems: ['Pages load slowly', '', 'No clear next step'] }) ?? '', /empty/);
  assert.match(checkHook({ ...ok, headline: 'Some signs your site is losing visitors' }) ?? '', /number/);
  assert.match(checkHook({ hook: 'numbered_list', headline: '9 ways to fix it', listItems: Array.from({ length: 9 }, (_, i) => `Item ${'abcdefghi'[i]}`) }) ?? '', /at most/);
  assert.match(checkHook({ hook: 'numbered_list', headline: '3 signs of trouble' }) ?? '', /listItems/);
});

test('a repeated opening or a near-identical headline is a warning, not a failure', () => {
  const recent = ['Is your website costing you customers', 'Keep project deadlines visible every day'];
  assert.deepEqual(repetitionWarnings('Is your website hard to use?', recent).map((w) => w.kind), ['opening']);
  assert.deepEqual(repetitionWarnings('Keep project deadlines visible every single day', recent).map((w) => w.kind).sort(), ['opening', 'similar']);
  assert.deepEqual(repetitionWarnings('A calmer way to book visits', recent), []);
});

test('repetition checks are skipped, and said to be, for scripts without spaces between words', () => {
  const warnings = repetitionWarnings('あなたのウェブサイトは顧客を逃していませんか', ['あなたのウェブサイトは顧客を逃していませんか']);
  assert.deepEqual(warnings.map((w) => w.kind), ['unsupported_language']);
});

test('the fallback headline is a complete, prevalidated line: the whole proof point, or the identity line, never a cut-off quote', () => {
  const anchored = fallbackHeadline({ anchor: 'Free first visit for new patients', identityLine: 'Family dental care for the whole town', maxChars: 60 });
  assert.equal(anchored, 'Free first visit for new patients');
  assert.equal(fallbackHeadline({ anchor: 'Available in selected locations only across the whole country this year', identityLine: 'Family dental care', maxChars: 60 }), undefined);
  assert.equal(fallbackHeadline({ identityLine: 'Family dental care for the whole town', maxChars: 60 }), 'Family dental care for the whole town');
  assert.equal(fallbackHeadline({ identityLine: 'x'.repeat(80), maxChars: 60 }), undefined);
  assert.equal(fallbackHeadline({ maxChars: 60 }), undefined);
});


test('a list item that joins several items with commas is refused, because the headline counts the items', () => {
  const problem = checkHook({ hook: 'numbered_list', headline: '4 platforms', listItems: ['WordPress', 'Webflow', 'Next.js, React, Vue', 'plain HTML'] });
  assert.match(problem ?? '', /single item/);
  assert.equal(checkHook({ hook: 'numbered_list', headline: '3 platforms', listItems: ['WordPress', 'Webflow', 'plain HTML'] }), undefined);
});
