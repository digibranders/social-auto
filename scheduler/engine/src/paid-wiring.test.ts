import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiConfigFromEnv, generateScene } from './ai.ts';
import { chatJson } from './llm.ts';
import { BudgetError, defaultBudgetLimits, PaidLedger, type BudgetLimits } from './paid-ledger.ts';

function setup(limits: Partial<BudgetLimits> = {}): { ai: ReturnType<typeof aiConfigFromEnv>; ledger: PaidLedger; dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-'));
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
  ai.warn = () => undefined;
  const ledger = new PaidLedger(join(dir, 'ledger.jsonl'), { ...defaultBudgetLimits, ...limits }, { jobId: 'job', tenantId: 'owner', brandId: 'acme' });
  ai.ledger = ledger;
  return { ai, ledger, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const reply = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20 }): typeof fetch => async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });

test('a text call is reserved, sent and recorded with its real cost', async () => {
  const { ai, ledger, done } = setup();
  try {
    ai.usage.post = 'p1';
    const out = await chatJson({ ai, system: 's', user: 'u', parse: (v) => v as { ok: boolean }, fetchFn: reply('{"ok":true}') });
    assert.deepEqual(out, { ok: true });
    const [call] = ledger.calls();
    assert.equal(call?.status, 'completed');
    assert.equal(call?.postId, 'p1');
    assert.ok((call?.actualCostUsd ?? 1) < (call?.reservedCostUsd ?? 0));
  } finally {
    done();
  }
});

test('a refused text call is never sent, and no backup provider or retry is used to get around the cap', async () => {
  const { ai, ledger, done } = setup({ perRunUsd: 0.0001 });
  try {
    let sent = 0;
    await assert.rejects(chatJson({ ai, system: 's', user: 'u', parse: (v) => v, fetchFn: async () => { sent += 1; return new Response('{}'); } }), BudgetError);
    assert.equal(sent, 0);
    assert.equal(ledger.calls().length, 0);
  } finally {
    done();
  }
});

test('a text call whose answer was lost is unknown, not retried', async () => {
  const { ai, ledger, done } = setup();
  try {
    await assert.rejects(chatJson({ ai, system: 's', user: 'u', parse: (v) => v, fetchFn: async () => { throw new Error('socket hang up'); } }));
    assert.equal(ledger.calls().length, 1);
    assert.equal(ledger.calls()[0]?.status, 'unknown');
  } finally {
    done();
  }
});

test('a picture is reserved first, one per poster, and a second purchase is refused without being sent', async () => {
  const { ai, ledger, dir, done } = setup();
  try {
    ai.usage.post = 'p1';
    let sent = 0;
    const png = Buffer.from('fake').toString('base64');
    const fetchFn: typeof fetch = async () => { sent += 1; return new Response(JSON.stringify({ data: [{ b64_json: png }], usage: { input_tokens: 100, output_tokens: 1000 } }), { status: 200 }); };
    const request = { prompt: 'a calm desk', outPath: join(dir, 'a.jpg'), width: 1024, height: 1024, seed: 1 };
    const budget = { openaiImages: 0 };
    assert.equal(await generateScene(ai, request, budget, fetchFn), 'OpenAI');
    assert.equal(ledger.calls()[0]?.outputPath, request.outPath);
    await assert.rejects(generateScene(ai, { ...request, prompt: 'another try', outPath: join(dir, 'b.jpg') }, budget, fetchFn), (error: unknown) => error instanceof BudgetError && error.code === 'IMAGE_LIMIT');
    assert.equal(sent, 1);
  } finally {
    done();
  }
});
