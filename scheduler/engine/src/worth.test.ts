import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { buildEvidence, type EvidenceFact } from './evidence.ts';
import type { PageBlock } from './evidence-extract.ts';
import { rankFacts } from './fact-assignment.ts';
import { modelWorthJudge } from './semantic-judge.ts';
import { loadWorth, saveWorth, scoreFacts, toScore, WORTH_VERSION, type WorthJudge } from './worth.ts';

const NOW = new Date('2026-11-04T00:00:00Z');
const block = (text: string): PageBlock => ({ id: 'b', text, tag: 'p', region: 'prose', isHeading: false, headingText: 'Features', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en' });
const facts = (): EvidenceFact[] => buildEvidence([{ url: 'https://acme.example/features', title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: [
  block('Relevance filtering or optional reranking for precise answers.'),
  block('Give each bot custom instructions and keep its answers grounded in your content.'),
  block('Add or remove documents and the index updates automatically.'),
] }], NOW).facts;

test('scores are clamped to 0 to 2 and added up', () => {
  assert.deepEqual(toScore({ relevance: 2, clarity: 1, value: 0 }), { relevance: 2, clarity: 1, value: 0, total: 3 });
  assert.deepEqual(toScore({ relevance: 9, clarity: -3, value: 1.4 }), { relevance: 2, clarity: 0, value: 1, total: 3 });
  assert.equal(toScore({ relevance: Number.NaN, clarity: 2, value: 2 } as never).total, 4);
});

test('only facts without a score are judged, in batches, and a judged fact is never judged again', async () => {
  const all = facts();
  const sizes: number[] = [];
  const judge: WorthJudge = async (items) => { sizes.push(items.length); return items.map((i) => ({ key: i.key, relevance: 2, clarity: 2, value: 1 })); };
  const first = await scoreFacts(all, {}, judge, { batchSize: 2 });
  assert.deepEqual(sizes, [2, 1]);
  assert.equal(first.judged, 3);
  assert.ok(all.every((f) => first.scores[f.id]?.total === 5));
  const second = await scoreFacts(all, first.scores, judge);
  assert.equal(second.judged, 0);
  assert.deepEqual(sizes, [2, 1]);
});

test('a failing judge scores nothing further and says why; known scores are kept', async () => {
  const all = facts();
  const known = { [all[0]?.id as string]: toScore({ relevance: 1, clarity: 1, value: 1 }) };
  const failing: WorthJudge = async () => { throw new Error('rate limited'); };
  const result = await scoreFacts(all, known, failing);
  assert.equal(result.failure, 'rate limited');
  assert.equal(result.judged, 0);
  assert.deepEqual(Object.keys(result.scores), Object.keys(known));
});

test('a verdict for a fact that was not asked about is ignored', async () => {
  const all = facts();
  const judge: WorthJudge = async () => [{ key: 'not-a-fact', relevance: 2, clarity: 2, value: 2 }];
  assert.deepEqual((await scoreFacts(all, {}, judge)).scores, {});
});

test('poster-worthy facts rank first whatever was used before, weak facts last, unjudged in between', () => {
  const all = facts();
  const [a, b, c] = all as [EvidenceFact, EvidenceFact, EvidenceFact];
  const ranked = rankFacts(all, [b.id, c.id], { [a.id]: 2, [b.id]: 6, [c.id]: 4 });
  assert.deepEqual(ranked.map((f) => f.id), [b.id, c.id, a.id]);
  const unjudged = rankFacts(all, [], { [a.id]: 1, [b.id]: 5 });
  assert.deepEqual(unjudged.map((f) => f.id), [b.id, c.id, a.id]);
});

test('scores are kept in the brand folder and read back; a damaged file starts again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worth-'));
  try {
    assert.deepEqual((await loadWorth(dir)).scores, {});
    await saveWorth(dir, { version: WORTH_VERSION, scores: { f1: toScore({ relevance: 2, clarity: 2, value: 2 }) } });
    assert.equal((await loadWorth(dir)).scores['f1']?.total, 6);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'facts-worth.json'), '{broken');
    assert.deepEqual((await loadWorth(dir)).scores, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the worth judge sends one request for the batch and reads three scores per fact', async () => {
  const bodies: string[] = [];
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scores: [{ key: 'a', relevance: 2, clarity: 1, value: 0 }, { key: 'b', relevance: 'x', clarity: 1, value: 1 }] }) } }] }), { status: 200 });
  }) as typeof fetch;
  const out = await modelWorthJudge(aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), fetchFn)([{ key: 'a', text: 'Custom instructions', context: 'Features' }, { key: 'b', text: 't', context: '' }]);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0] ?? '', /Custom instructions/);
  assert.deepEqual(out, [{ key: 'a', relevance: 2, clarity: 1, value: 0 }]);
});
