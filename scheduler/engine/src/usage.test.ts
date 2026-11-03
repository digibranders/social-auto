import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv, generateScene } from './ai.ts';
import { chatJson } from './llm.ts';
import { appendUsageLog, costOf, flatImageCost, UsageTally, type UsageRecord } from './usage.ts';

test('cost is tokens times the model\'s price per million, and unknown models are flagged instead of guessed', () => {
  assert.equal(costOf({ kind: 'text', model: 'gpt-6-luna', inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0.6);
  assert.equal(costOf({ kind: 'text', model: 'gpt-6.1-terra', inputTokens: 3000, outputTokens: 2450 }), 0.01525);
  assert.equal(costOf({ kind: 'image', model: 'gpt-image-2.5-flare', inputTokens: 100, outputTokens: 1000 }), 0.0305);
  assert.equal(costOf({ kind: 'text', model: 'some-new-model', inputTokens: 5, outputTokens: 5 }), null);
});

test('a picture without token counts is priced from OpenAI\'s per-picture table by quality', () => {
  assert.equal(flatImageCost('low'), 0.006);
  assert.equal(flatImageCost('medium'), 0.053);
  assert.equal(flatImageCost('high'), 0.211);
});

test('the tally adds up calls, tokens and cost per model and says what is only an estimate', () => {
  const tally = new UsageTally();
  tally.add({ kind: 'text', model: 'gpt-6-luna', inputTokens: 2000, outputTokens: 1000 });
  tally.add({ kind: 'text', model: 'gpt-6-luna', inputTokens: 1000, outputTokens: 500 });
  tally.add({ kind: 'image', model: 'gpt-image-2.5-flare', inputTokens: 0, outputTokens: 0, flatCost: 0.053 });
  tally.add({ kind: 'text', model: 'mystery', inputTokens: 1, outputTokens: 1 });
  const s = tally.summary();
  const luna = s.lines.find((l) => l.model === 'gpt-6-luna');
  assert.deepEqual([luna?.calls, luna?.inputTokens, luna?.outputTokens], [2, 3000, 1500]);
  assert.equal(luna?.costUsd, 0.00105);
  const picture = s.lines.find((l) => l.kind === 'image');
  assert.equal(picture?.estimated, true);
  assert.equal(picture?.costUsd, 0.053);
  assert.equal(s.lines.find((l) => l.model === 'mystery')?.costUsd, null);
  assert.equal(s.totalUsd, 0.05405);
  assert.equal(s.hasUnknown, true);
  assert.match(tally.format(), /gpt-6-luna.*2 calls/);
  assert.match(tally.format(), /Total.*\$0\.05/);
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('every text answer and every picture OpenAI makes is counted, with OpenAI\'s own token numbers when it gives them', async () => {
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' });
  await chatJson({
    ai, system: 's', user: 'u', parse: (v) => v,
    fetchFn: (async () => json({ choices: [{ message: { content: '{"ok":1}' } }], usage: { prompt_tokens: 120, completion_tokens: 30 } })) as typeof fetch,
  });
  const dir = await mkdtemp(join(tmpdir(), 'usage-test-'));
  try {
    const withTokens = (async () => json({ data: [{ b64_json: Buffer.from([1, 2, 3]).toString('base64') }], usage: { input_tokens: 80, output_tokens: 1056 } })) as typeof fetch;
    const withoutTokens = (async () => json({ data: [{ b64_json: Buffer.from([1, 2, 3]).toString('base64') }] })) as typeof fetch;
    const request = (name: string) => ({ prompt: 'p', outPath: join(dir, name), width: 1088, height: 1088, seed: 1 });
    await generateScene(ai, request('a.jpg'), { openaiImages: 0 }, withTokens);
    await generateScene(ai, request('b.jpg'), { openaiImages: 0 }, withoutTokens);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const lines = ai.usage.summary().lines;
  const text = lines.find((l) => l.kind === 'text');
  assert.deepEqual([text?.calls, text?.inputTokens, text?.outputTokens], [1, 120, 30]);
  const picture = lines.find((l) => l.kind === 'image');
  assert.equal(picture?.calls, 2);
  assert.equal(picture?.estimated, true, 'one of the two pictures had no token counts');
});

test('each call is kept as a record: pictures belong to their post, website reading to the client, and the week\'s writing is shared across its posts', () => {
  const tally = new UsageTally();
  tally.purpose = 'profile';
  tally.add({ kind: 'text', model: 'gpt-6-luna', inputTokens: 1_000_000, outputTokens: 0 });
  tally.purpose = 'writing';
  tally.add({ kind: 'text', model: 'gpt-6-luna', inputTokens: 0, outputTokens: 1_000_000 });
  tally.post = 'w01-d2';
  tally.add({ kind: 'image', model: 'gpt-image-2.5-flare', inputTokens: 0, outputTokens: 0, flatCost: 0.0138 });

  const records = tally.records('fynix', ['w01-d1', 'w01-d2'], new Date('2026-11-04T05:00:00Z'));
  const profile = records.filter((r) => r.purpose === 'profile');
  assert.deepEqual(profile.map((r) => [r.client, r.post, r.costUsd]), [['fynix', null, 0.1]]);
  const writing = records.filter((r) => r.purpose === 'writing');
  assert.deepEqual(writing.map((r) => [r.post, r.costUsd]), [['w01-d1', 0.25], ['w01-d2', 0.25]]);
  const picture = records.filter((r) => r.purpose === 'picture');
  assert.deepEqual(picture.map((r) => [r.post, r.costUsd, r.estimated, r.at]), [['w01-d2', 0.0138, true, '2026-11-04T05:00:00.000Z']]);
});

test('the usage log gets one JSON line per record and keeps what was already there', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'usage-log-'));
  try {
    const file = join(dir, 'nested', 'usage.jsonl');
    const record = (post: string): UsageRecord => ({ at: '2026-11-04T05:00:00.000Z', client: 'fynix', post, purpose: 'picture', model: 'm', inputTokens: 0, outputTokens: 0, costUsd: 0.01, estimated: false });
    await appendUsageLog(file, [record('a')]);
    await appendUsageLog(file, [record('b'), record('c')]);
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as UsageRecord);
    assert.deepEqual(lines.map((l) => l.post), ['a', 'b', 'c']);
    await appendUsageLog(file, []);
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
