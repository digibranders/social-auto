import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawableFactIds, DRAW_FACT_MAX_AGE_DAYS, postsWithOutdatedFacts } from './fact-recheck.ts';
import { NOT_DRAWN_REASON } from './not-drawn.ts';
import type { EvidenceFact } from './evidence.ts';
import type { ReviewFile } from './fact-review.ts';
import { applyFreshness } from './commercial.ts';

const fact = (id: string, status: string): EvidenceFact => ({ id, status }) as unknown as EvidenceFact;
const review = (decisions: Record<string, 'approved' | 'rejected'>): ReviewFile => ({ version: 1, decisions: Object.fromEntries(Object.entries(decisions).map(([id, decision]) => [id, { decision, text: 't', decidedAt: '2026-11-12T00:00:00Z' }])) });

test('a fact is drawable while it is usable now and the customer has not taken it out; confirming other facts later does not turn the rest into a reason not to draw', () => {
  const facts = [fact('a', 'usable'), fact('b', 'usable'), fact('c', 'stale'), fact('d', 'usable')];
  assert.deepEqual([...drawableFactIds(facts, null)].sort(), ['a', 'b', 'd']);
  assert.deepEqual([...drawableFactIds(facts, review({ b: 'rejected' }))].sort(), ['a', 'd'], 'she took b out');
  assert.deepEqual([...drawableFactIds(facts, review({ a: 'approved' }))].sort(), ['a', 'b', 'd'], 'approving one fact does not exclude the unconfirmed ones');
});

test('a post that rests on a fact that is no longer drawable is found; one with no facts recorded is not judged', () => {
  const drawable = new Set(['a', 'd']);
  const posts = [{ id: 'p1', factIds: ['a'] }, { id: 'p2', factIds: ['a', 'b'] }, { id: 'p3', factIds: [] }, { id: 'p4' }, { id: 'p5', factIds: ['z'] }];
  assert.deepEqual(postsWithOutdatedFacts(posts, drawable), ['p2', 'p5']);
  assert.deepEqual(postsWithOutdatedFacts([], drawable), []);
});

test('a price or an offer is stale at the draw once it is older than the limit, while a plain fact never is', () => {
  const now = new Date('2026-12-20T05:00:00Z');
  const priced = (id: string, capturedAt: string) => ({ id, category: 'commercial_term', capturedAt, status: 'usable', reasonCodes: [] }) as unknown as EvidenceFact;
  const plain = { id: 'plain', category: 'capability', capturedAt: '2026-01-01T00:00:00Z', status: 'usable', reasonCodes: [] } as unknown as EvidenceFact;
  const checked = applyFreshness([priced('new', '2026-11-25T00:00:00Z'), priced('old', '2026-11-01T00:00:00Z'), plain], now, DRAW_FACT_MAX_AGE_DAYS);
  assert.deepEqual([...drawableFactIds(checked, null)].sort(), ['new', 'plain'], '25 days old is fine, 49 days old is stale, a plain fact never goes stale');
  assert.equal(DRAW_FACT_MAX_AGE_DAYS, 45);
});

test('the sentence for a post that is not drawn because of its facts is plain and says what to do', () => {
  assert.match(NOT_DRAWN_REASON.FACT_OUT_OF_DATE, /out of date or was taken out.*Drop this topic, or put the fact back/);
});
