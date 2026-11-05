import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildEvidence, type EvidenceFact } from './evidence.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';
import { cacheKey, deterministicFailures, fileCache, memoryCache, verifyParaphrases, type Judge, type JudgeItem } from './semantic-verifier.ts';

const NOW = new Date('2026-11-04T00:00:00Z');
const block = (over: Partial<PageBlock>): PageBlock => ({ id: 'b', text: '', tag: 'p', region: 'prose', isHeading: false, headingText: 'Setup', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const factOf = (text: string, over: Partial<PageBlock> = {}, url = 'https://x.example/features'): EvidenceFact => {
  const structure: PageStructure = { url, title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: [block({ text, ...over })] };
  return buildEvidence([structure], NOW).facts[0] as EvidenceFact;
};

const answering = (answer: 'supported' | 'unsupported' | 'unclear', calls: JudgeItem[][] = []): Judge => async (items) => {
  calls.push(items);
  return items.map((i) => ({ key: i.key, answer }));
};

test('deterministic checks reject without asking the judge', async () => {
  const fact = factOf('Installation takes under 10 minutes and uses one script tag.');
  const calls: JudgeItem[][] = [];
  const results = await verifyParaphrases([
    { claim: 'Setup takes 5 minutes.', fact },
    { claim: 'Setup takes 10 minutes.', fact },
    { claim: 'Install with a single script tag in under 10 minutes.', fact },
  ], answering('supported', calls), memoryCache(), { tenant: 'acme' });
  assert.equal(results[0]?.status, 'rejected');
  assert.match(results[0]?.reasons.join(' ') ?? '', /states 5/);
  assert.equal(results[1]?.status, 'rejected');
  assert.match(results[1]?.reasons.join(' ') ?? '', /qualifier "less than"/);
  assert.equal(results[2]?.status, 'supported_by_model');
  assert.equal(calls.flat().length, 1);
});

test('a fact held for review, a target, an example or another party never goes to the judge', async () => {
  const calls: JudgeItem[][] = [];
  const held = [
    factOf('Our uptime target is 99.9% every month.'),
    factOf('Sample dashboard shows 87 leads.'),
    factOf('Northwind handled 500 chats.', {}, 'https://x.example/case-studies'),
    factOf('Acme responde a las preguntas.', { lang: 'es' }),
  ];
  const results = await verifyParaphrases(held.map((fact) => ({ claim: fact.text, fact })), answering('supported', calls), memoryCache(), { tenant: 'acme' });
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(calls.length, 0);
  assert.match(deterministicFailures('x', held[1] as EvidenceFact).join(' '), /example/);
});

test('judge answers: supported is never "verified", unsupported rejects, unclear stays uncertain', async () => {
  const fact = factOf('Chats move to an operator in the same thread with the transcript attached.');
  for (const [answer, status] of [['supported', 'supported_by_model'], ['unsupported', 'rejected'], ['unclear', 'uncertain']] as const) {
    const [r] = await verifyParaphrases([{ claim: 'A person takes over the same conversation.', fact }], answering(answer), memoryCache(), { tenant: 'acme' });
    assert.equal(r?.status, status);
    assert.ok(!/verified/i.test(r?.reasons.join(' ') ?? '') || /not verified/.test(r?.reasons.join(' ') ?? ''));
  }
});

test('answers are cached per tenant, source and claim; a second run asks nothing', async () => {
  const fact = factOf('Chats move to an operator in the same thread with the transcript attached.');
  const cache = memoryCache();
  const calls: JudgeItem[][] = [];
  const input = [{ claim: 'A person takes over the same conversation.', fact }];
  await verifyParaphrases(input, answering('supported', calls), cache, { tenant: 'acme' });
  const second = await verifyParaphrases(input, answering('supported', calls), cache, { tenant: 'acme' });
  assert.equal(calls.length, 1);
  assert.equal(second[0]?.cached, true);
  await verifyParaphrases(input, answering('supported', calls), cache, { tenant: 'other' });
  assert.equal(calls.length, 2);
  const changed = factOf('Chats move to an operator in the same thread with the transcript attached. Extra.');
  assert.notEqual(cacheKey('acme', fact, 'x'), cacheKey('acme', changed, 'x'));
  assert.notEqual(cacheKey('acme', fact, 'x'), cacheKey('acme', fact, 'y'));
});

test('duplicates are asked once, batches are cut to the batch size, a missing answer stays uncertain', async () => {
  const fact = factOf('Chats move to an operator in the same thread with the transcript attached.');
  const claims = ['A person takes over.', 'A human joins the chat.', 'An agent continues the thread.', 'A person takes over.'];
  const sizes: number[] = [];
  const judge: Judge = async (items) => { sizes.push(items.length); return items.slice(0, -1).map((i) => ({ key: i.key, answer: 'supported' as const })); };
  const results = await verifyParaphrases(claims.map((claim) => ({ claim, fact })), judge, memoryCache(), { tenant: 'acme', batchSize: 2 });
  assert.deepEqual(sizes, [2, 1]);
  assert.equal(results[0]?.status, 'supported_by_model');
  assert.equal(results[3]?.status, 'supported_by_model');
  assert.equal(results[2]?.status, 'uncertain');
  assert.match(results[2]?.reasons.join(' ') ?? '', /no answer/);
});

test('a failing judge leaves everything uncertain and caches nothing', async () => {
  const fact = factOf('Chats move to an operator in the same thread with the transcript attached.');
  const cache = memoryCache();
  const failing: Judge = async () => { throw new Error('rate limited'); };
  const [r] = await verifyParaphrases([{ claim: 'A person takes over.', fact }], failing, cache, { tenant: 'acme' });
  assert.equal(r?.status, 'uncertain');
  assert.match(r?.reasons.join(' ') ?? '', /rate limited/);
  assert.equal(cache.get(cacheKey('acme', fact, 'A person takes over.')), undefined);
});

test('the file cache survives a restart and ignores a damaged file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'verdicts-'));
  try {
    const path = join(dir, 'nested', 'verdicts.json');
    const first = await fileCache(path);
    first.set('k1', 'supported');
    await first.save();
    assert.equal((await fileCache(path)).get('k1'), 'supported');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{broken');
    assert.equal((await fileCache(path)).get('k1'), undefined);
    await writeFile(path, JSON.stringify({ a: 'supported', b: 'maybe', c: 5 }));
    const loaded = await fileCache(path);
    assert.equal(loaded.get('a'), 'supported');
    assert.equal(loaded.get('b'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { copyCacheKey, verifyCopySupport } from './semantic-verifier.ts';

const copyOf = (headline: string, subline: string, caption = 'A short note.') => ({ headline, subline, caption });

test('copy check: one request for the whole batch, answers mapped to posts, supported is model-judged only', async () => {
  const fact = factOf('The chatbot can suggest responses.');
  const sizes: number[] = [];
  const judge: Judge = async (items) => { sizes.push(items.length); return items.map((i) => ({ key: i.key, answer: /automatically/.test(i.claim) ? 'unsupported' as const : /maybe/.test(i.claim) ? 'unclear' as const : 'supported' as const })); };
  const inputs = [
    { copy: copyOf('Replies, suggested', 'Acme Replies can suggest responses.'), facts: [fact] },
    { copy: copyOf('Resolves every request', 'Acme Replies automatically resolves them.'), facts: [fact] },
    { copy: copyOf('Maybe helpful', 'maybe'), facts: [fact] },
  ];
  const results = await verifyCopySupport(inputs, judge, memoryCache(), { tenant: 'acme' });
  assert.deepEqual(sizes, [3]);
  assert.deepEqual(results.map((r) => r.status), ['supported_by_model', 'rejected', 'uncertain']);
  assert.match(results[0]?.reasons.join(' ') ?? '', /not verified by code/);
});

test('copy check: cached answers are not asked again, a failing judge leaves posts uncertain and caches nothing', async () => {
  const fact = factOf('The chatbot can suggest responses.');
  const input = { copy: copyOf('Replies, suggested', 'Acme Replies can suggest responses.'), facts: [fact] };
  const cache = memoryCache();
  let calls = 0;
  const ok: Judge = async (items) => { calls += 1; return items.map((i) => ({ key: i.key, answer: 'supported' as const })); };
  await verifyCopySupport([input], ok, cache, { tenant: 'acme' });
  const again = await verifyCopySupport([input], ok, cache, { tenant: 'acme' });
  assert.equal(calls, 1);
  assert.equal(again[0]?.cached, true);
  const other = memoryCache();
  const failing: Judge = async () => { throw new Error('timeout'); };
  const [r] = await verifyCopySupport([input], failing, other, { tenant: 'acme' });
  assert.equal(r?.status, 'uncertain');
  assert.match(r?.reasons.join(' ') ?? '', /timeout/);
  assert.equal(other.get(copyCacheKey('acme', input)), undefined);
  assert.notEqual(copyCacheKey('acme', input), copyCacheKey('other', input));
});
