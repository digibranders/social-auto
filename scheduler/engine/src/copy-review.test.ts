import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewCandidate, reviewCandidates, type ReviewDeps, type ReviewInput } from './copy-review.ts';
import type { ClaimVerdict } from './claim-verdict.ts';
import type { EvidenceFact } from './evidence.ts';
import { BudgetError } from './paid-ledger.ts';

const QUOTE = 'OyeChats never trains models on your data.';
const fact = { id: 'f1', text: QUOTE, source: { url: 'u', quote: QUOTE, context: 'Privacy', heading: '', contentHash: 'h', regionType: 'prose', pageRole: 'home' }, values: { numbers: [], prices: [], currencies: [], periods: [], units: [] }, qualifiers: [] } as unknown as EvidenceFact;
const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({ id: 'c1', facts: [fact], draft: { headline: 'OyeChats never trains models on your data', subline: '', caption: 'Your chats stay yours.' }, ...over });

const covers = (draft: ReviewInput['draft']): ClaimVerdict => ({
  decision: 'SUPPORTED', factId: 'f1', violations: [],
  coverage: [{ field: 'headline', claimText: draft.headline, sourceQuote: QUOTE }, ...(draft.caption.trim() ? [{ field: 'caption' as const, claimText: draft.caption, sourceQuote: QUOTE }] : [])],
});
const unsupported: ClaimVerdict = { decision: 'UNSUPPORTED', factId: 'f1', coverage: [], violations: [{ field: 'caption', unsupportedText: 'Your chats stay yours', reasonCode: 'UNSUPPORTED_SCOPE', explanation: 'The source says nothing about who owns chats.', sourceContext: QUOTE }] };
const vague: ClaimVerdict = { decision: 'UNSUPPORTED', factId: 'f1', coverage: [], violations: [] };

function deps(over: Partial<ReviewDeps> & { calls?: string[] } = {}): ReviewDeps {
  const calls = over.calls ?? [];
  return {
    judge: async (i) => { calls.push('judge'); return covers(i.draft); },
    adjudicate: async (i) => { calls.push('adjudicate'); return covers(i.draft); },
    rewrite: async () => { calls.push('rewrite'); return { factId: 'f1', headline: 'OyeChats never trains models on your data', subline: '', caption: 'Your data is not used to train models.' }; },
    recheck: () => [],
    ...over,
  };
}

test('a supported candidate goes on untouched, with one call', async () => {
  const calls: string[] = [];
  const out = await reviewCandidate(input(), deps({ calls }));
  assert.equal(out.status, 'accepted');
  assert.equal(out.rewritten, false);
  assert.deepEqual(calls, ['judge']);
});

test('an unsupported caption is rewritten once, rechecked, rejudged, and the rewrite is used', async () => {
  const calls: string[] = [];
  let first = true;
  const out = await reviewCandidate(input(), deps({ calls, judge: async (i) => { calls.push('judge'); if (first) { first = false; return unsupported; } return covers(i.draft); } }));
  assert.equal(out.status, 'accepted');
  assert.equal(out.rewritten, true);
  assert.equal(out.draft.caption, 'Your data is not used to train models.');
  assert.deepEqual(calls, ['judge', 'rewrite', 'judge']);
  assert.deepEqual(out.trail.map((t) => t.step), ['judge', 'rewrite', 'recheck', 'rejudge']);
});

test('a rewrite that drops the source negation is refused and the candidate is dropped', async () => {
  const out = await reviewCandidate(input(), deps({ judge: async () => unsupported, rewrite: async () => ({ factId: 'f1', headline: 'OyeChats trains models on your data', subline: '', caption: 'Your data helps models improve.' }) }));
  assert.equal(out.status, 'dropped');
  assert.match(out.reasons.join(' '), /drops the negation "never"/);
});

test('a rewrite that fails the ordinary checks again, or is not judged supported, is dropped: one rewrite, never a loop', async () => {
  const again = await reviewCandidate(input(), deps({ judge: async () => unsupported, recheck: () => ['the headline begins with the brand name as a label'] }));
  assert.equal(again.status, 'dropped');
  assert.match(again.reasons.join(' '), /failed the checks again/);
  const calls: string[] = [];
  const stillBad = await reviewCandidate(input(), deps({ calls, judge: async () => { calls.push('judge'); return unsupported; } }));
  assert.equal(stillBad.status, 'dropped');
  assert.deepEqual(calls, ['judge', 'rewrite', 'judge'], 'exactly one rewrite and one rejudge');
});

test('a vague verdict goes to one focused adjudication; its answer decides, and a second unclear answer drops the candidate', async () => {
  const calls: string[] = [];
  const ok = await reviewCandidate(input(), deps({ calls, judge: async () => { calls.push('judge'); return vague; } }));
  assert.equal(ok.status, 'accepted');
  assert.deepEqual(calls, ['judge', 'adjudicate']);
  const stuck = await reviewCandidate(input(), deps({ judge: async () => vague, adjudicate: async () => vague }));
  assert.equal(stuck.status, 'dropped');
  assert.match(stuck.reasons.join(' '), /stayed unclear/);
});

test('an adjudication that names a real violation leads to the one rewrite', async () => {
  let rewrites = 0;
  let asked = 0;
  const out = await reviewCandidate(input(), deps({ judge: async (i) => (asked++ === 0 ? vague : covers(i.draft)), adjudicate: async () => unsupported, rewrite: async () => { rewrites += 1; return { factId: 'f1', headline: 'OyeChats never trains models on your data', subline: '', caption: 'Your data is not used to train models.' }; } }));
  assert.equal(rewrites, 1);
  assert.equal(out.status, 'accepted');
  assert.equal(out.rewritten, true);
});

test('a deterministic hold wins over a model that says supported, a judge that fails drops the candidate, and a spending refusal is not swallowed', async () => {
  const held = await reviewCandidate(input({ deterministicHold: true }), deps());
  assert.equal(held.status, 'dropped');
  const failed = await reviewCandidate(input(), deps({ judge: async () => { throw new Error('No valid response'); } }));
  assert.equal(failed.status, 'dropped');
  assert.match(failed.reasons.join(' '), /could not give a verdict/);
  await assert.rejects(reviewCandidate(input(), deps({ judge: async () => { throw new BudgetError('RUN_BUDGET', 'over the limit'); } })), BudgetError);
  assert.equal((await reviewCandidate(input({ facts: [] }), deps())).status, 'dropped');
});

test('candidates are reviewed together and come back in order', async () => {
  const out = await reviewCandidates([input({ id: 'a' }), input({ id: 'b', deterministicHold: true }), input({ id: 'c' })], deps(), 2);
  assert.deepEqual(out.map((o) => `${o.id}:${o.status}`), ['a:accepted', 'b:dropped', 'c:accepted']);
});
