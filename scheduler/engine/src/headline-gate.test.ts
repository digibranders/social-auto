import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiConfigFromEnv } from './ai.ts';
import { defaultHeadlineGate, headlineGateFromEnv, judgeHeadlines, scoreHeadlines, type HeadlineScore } from './headline-gate.ts';
import { makeCreatives } from './ai-creative-pipeline.ts';
import type { CreativeReview } from './ai-creative.ts';
import type { Brand, PlannedPost } from './content.ts';
import { BudgetError } from './paid-ledger.ts';

const score = (id: string, informative: number, natural: number, reason = ''): HeadlineScore => ({ id, informative, natural, reason });

test('a headline that tells the reader nothing, or does not read as copy, is dropped; a specific natural one is kept', () => {
  const verdicts = judgeHeadlines([
    score('specific', 2, 2),
    score('general-but-natural', 1, 2),
    score('filler', 0, 2, 'a list of nouns'),
    score('stilted', 2, 0, 'awkward'),
    score('thin', 1, 1),
  ]);
  assert.deepEqual(verdicts.map((v) => [v.id, v.keep]), [['specific', true], ['general-but-natural', true], ['filler', false], ['stilted', false], ['thin', false]]);
  assert.match(verdicts[2]?.reason ?? '', /tells the reader nothing specific.*a list of nouns/);
  assert.match(verdicts[3]?.reason ?? '', /natural copy/);
  assert.match(verdicts[4]?.reason ?? '', /too weak/);
  assert.equal(judgeHeadlines([score('thin', 1, 1)], { minTotal: 2 })[0]?.keep, true, 'the threshold is a setting');
});

test('one request scores the whole batch, and an answer that misses a post or is malformed is an error, not a pass', async () => {
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
  let requests = 0;
  const answer = (content: unknown): typeof fetch => async (_url, init) => {
    requests += 1;
    assert.match(String(init?.body), /headline/);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  };
  const items = [{ id: 'a', headline: 'H1', fact: 'f1' }, { id: 'b', headline: 'H2', fact: 'f2' }];
  const good = await scoreHeadlines(ai, items, answer({ scores: [{ id: 'a', informative: 2, natural: 2, reason: 'clear' }, { id: 'b', informative: 0, natural: 1, reason: 'vague' }] }));
  assert.equal(requests, 1);
  assert.deepEqual(good.map((s) => [s.id, s.informative, s.natural]), [['a', 2, 2], ['b', 0, 1]]);
  await assert.rejects(scoreHeadlines(ai, items, answer({ scores: [{ id: 'a', informative: 2, natural: 2 }] })), /No valid response/);
  await assert.rejects(scoreHeadlines(ai, items, answer({ scores: [{ id: 'a', informative: 5, natural: 2 }, { id: 'b', informative: 1, natural: 1 }] })), /No valid response/);
  assert.deepEqual(await scoreHeadlines(ai, [], answer({})), []);
});

test('the gate is on unless switched off, and its threshold must be a sensible number', () => {
  assert.deepEqual(headlineGateFromEnv({}), { enabled: true, config: defaultHeadlineGate });
  assert.equal(headlineGateFromEnv({ HEADLINE_GATE_ENABLED: 'false' }).enabled, false);
  assert.equal(headlineGateFromEnv({ HEADLINE_GATE_MIN_TOTAL: '2' }).config.minTotal, 2);
  assert.throws(() => headlineGateFromEnv({ HEADLINE_GATE_MIN_TOTAL: '9' }), /HEADLINE_GATE_MIN_TOTAL/);
});

// ---- In the pipeline

const brand = { name: 'OyeChats', website: 'https://www.oyechats.com', colors: { background: '#FFFFFF', ink: '#111111', accent: '#6B3FD4', tile: '#EEEEEE' } } as unknown as Brand;
const post = (id: string, headline: string): PlannedPost => ({ id, headline }) as unknown as PlannedPost;
const clean: CreativeReview['marks'] = { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false };
const reading = (headline: string): CreativeReview => ({ regions: [{ text: headline, readable: true }, { text: 'OyeChats', readable: true }, { text: 'oyechats.com', readable: true }], marks: { ...clean }, relevance: 2, composition: 2, readableSmall: true, notes: 'none' });

async function run(headlines: Array<[string, string]>, deps: NonNullable<Parameters<typeof makeCreatives>[0]['deps']>) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
    const drawn: string[] = [];
    const report = await makeCreatives({
      ai, brand, brandSlug: 'oyechats', outDir: join(dir, 'out'), posts: headlines.map(([id, h]) => post(id, h)), factOf: () => 'a verified fact',
      deps: {
        scene: async (prompt, out) => { drawn.push(prompt); writeFileSync(out, 'x'); },
        review: async (file) => reading(headlines.find(([id]) => file.includes(id))?.[1] ?? ''),
        ...deps,
      },
    });
    return { report, drawn };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const on = { enabled: true, config: defaultHeadlineGate };

test('a weak headline is dropped before any picture is bought, with its scores in the report; the others go on', async () => {
  const { report, drawn } = await run([['p1', 'Custom websites that fit your goals'], ['p2', 'Services for businesses of all sizes'], ['p3', 'Unique website, made together']], {
    headlineGate: on,
    headlines: async (items) => items.map((i) => (i.id === 'p1' ? score(i.id, 2, 2, 'specific') : i.id === 'p2' ? score(i.id, 0, 2, 'filler') : score(i.id, 1, 0, 'stilted'))),
  });
  assert.deepEqual(report.results.map((r) => r.status), ['accepted', 'dropped', 'dropped']);
  assert.equal(drawn.length, 1, 'one picture bought, for the one headline worth it');
  assert.match(report.results[1]?.reason ?? '', /weak headline: it tells the reader nothing specific/);
  assert.match(report.results[2]?.reason ?? '', /natural copy/);
  assert.equal(report.results[0]?.headline?.informative, 2);
});

test('when every headline is weak, nothing is bought and the batch is empty rather than padded', async () => {
  const { report, drawn } = await run([['p1', 'Everything you need'], ['p2', 'Services for all']], { headlineGate: on, headlines: async (items) => items.map((i) => score(i.id, 0, 1)) });
  assert.deepEqual(report.results.map((r) => r.status), ['dropped', 'dropped']);
  assert.equal(drawn.length, 0);
});

test('with the gate switched off nothing is checked and every headline goes on', async () => {
  let asked = 0;
  const { report, drawn } = await run([['p1', 'Services for all']], { headlineGate: { enabled: false, config: defaultHeadlineGate }, headlines: async (items) => { asked += 1; return items.map((i) => score(i.id, 0, 0)); } });
  assert.equal(asked, 0);
  assert.equal(report.results[0]?.status, 'accepted');
  assert.equal(drawn.length, 1);
});

test('if the check itself fails, the posts go on as they did before the gate, and the report says nothing was dropped', async () => {
  const logged: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
    const report = await makeCreatives({
      ai, brand, brandSlug: 'oyechats', outDir: join(dir, 'out'), posts: [post('p1', 'Answers from your own docs')], factOf: () => 'f', log: (m) => logged.push(m),
      deps: { headlineGate: on, headlines: async () => { throw new Error('No valid response'); }, scene: async (_p, out) => writeFileSync(out, 'x'), review: async () => reading('Answers from your own docs') },
    });
    assert.equal(report.results[0]?.status, 'accepted');
    assert.ok(logged.some((m) => /headline check could not be made/.test(m)));
    assert.equal(report.results[0]?.headline, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a spending cap that stops the check stops the run before anything is drawn', async () => {
  const { report, drawn } = await run([['p1', 'A'], ['p2', 'B']], { headlineGate: on, headlines: async () => { throw new BudgetError('RUN_BUDGET', 'this run would spend more than its limit'); } });
  assert.deepEqual(report.results.map((r) => r.status), ['budget_stopped', 'budget_stopped']);
  assert.match(report.stoppedBy ?? '', /RUN_BUDGET/);
  assert.equal(drawn.length, 0);
});
