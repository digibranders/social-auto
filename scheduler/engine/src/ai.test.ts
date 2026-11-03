import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv, AiConfigError, generateScene, textCandidates, type AiConfig } from './ai.ts';
import { chatJson, LlmError } from './llm.ts';

const OPENAI = 'sk-test-openai-key';
const POLL = 'pk-test-pollinations-key';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const reply = (content: string): Response => json({ choices: [{ message: { content } }] });

/** A fetch that records every call and answers from a script. */
function scripted(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> | null }> = [];
  const fetchFn = (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init, body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    return answer(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const both = (): AiConfig => aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL, AI_FALLBACK: 'on' });

test('with an OpenAI key OpenAI is the main provider, with the recommended models and Pollinations as backup', () => {
  const ai = both();
  assert.equal(ai.primary, 'openai');
  assert.equal(ai.fallback, true);
  assert.equal(ai.textModel, 'gpt-6-luna');
  assert.equal(ai.imageModel, 'gpt-image-2.5-sunburst');
  assert.equal(ai.imageQuality, 'medium');
  assert.equal(ai.maxOpenAiImages, 40);
  const only = aiConfigFromEnv({ OPENAI_API_KEY: OPENAI });
  assert.equal(only.fallback, false);
});

test('settings choose the provider, models, quality, limit and backup', () => {
  const ai = aiConfigFromEnv({
    OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL, OPENAI_TEXT_MODEL: 'gpt-6.1-terra', OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst',
    OPENAI_IMAGE_QUALITY: 'low', OPENAI_MAX_IMAGES_PER_RUN: '5', AI_FALLBACK: 'off',
  });
  assert.deepEqual([ai.textModel, ai.imageModel, ai.imageQuality, ai.maxOpenAiImages, ai.fallback], ['gpt-6.1-terra', 'gpt-image-2.5-sunburst', 'low', 5, false]);
  assert.equal(aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL, AI_PROVIDER: 'pollinations' }).primary, 'pollinations');
  assert.equal(aiConfigFromEnv({ POLLINATIONS_API_KEY: POLL }).primary, 'pollinations');
});

test('missing keys and unknown settings are refused with a clear message', () => {
  assert.throws(() => aiConfigFromEnv({}), AiConfigError);
  assert.throws(() => aiConfigFromEnv({}), /OPENAI_API_KEY/);
  assert.throws(() => aiConfigFromEnv({ POLLINATIONS_API_KEY: POLL, AI_PROVIDER: 'openai' }), /OPENAI_API_KEY/);
  assert.throws(() => aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, AI_PROVIDER: 'pollinations' }), /POLLINATIONS_API_KEY/);
  assert.throws(() => aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, AI_PROVIDER: 'claude' }), /AI_PROVIDER/);
  assert.throws(() => aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, OPENAI_IMAGE_QUALITY: 'ultra' }), /OPENAI_IMAGE_QUALITY/);
  assert.throws(() => aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, OPENAI_MAX_IMAGES_PER_RUN: '0' }), /OPENAI_MAX_IMAGES_PER_RUN/);
});

test('text goes to OpenAI first, then to the Pollinations models when the backup is on', () => {
  const labels = textCandidates(both()).map((c) => `${c.label}:${c.model}`);
  assert.equal(labels[0], 'OpenAI:gpt-6-luna');
  assert.ok(labels.slice(1).every((l) => l.startsWith('Pollinations:')) && labels.length > 1);
  assert.deepEqual(textCandidates(aiConfigFromEnv({ OPENAI_API_KEY: OPENAI })).map((c) => c.label), ['OpenAI']);
});

test('chatJson asks OpenAI for JSON with the key and model, and returns the parsed answer', async () => {
  const { fetchFn, calls } = scripted(() => reply('{"ok":true}'));
  const result = await chatJson({ ai: both(), system: 's', user: 'u', parse: (v) => v as { ok: boolean }, fetchFn });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal((calls[0]?.init.headers as Record<string, string>)['Authorization'], `Bearer ${OPENAI}`);
  assert.equal(calls[0]?.body?.['model'], 'gpt-6-luna');
  assert.deepEqual(calls[0]?.body?.['response_format'], { type: 'json_object' });
});

test('chatJson falls back to Pollinations when OpenAI fails, and never leaks a key in the error', async () => {
  const { fetchFn, calls } = scripted((url) => (url.includes('openai.com') ? json({ error: { message: 'down' } }, 500) : reply('{"from":"pollinations"}')));
  assert.deepEqual(await chatJson({ ai: both(), system: 's', user: 'u', parse: (v) => v as object, fetchFn }), { from: 'pollinations' });
  assert.ok(calls[0]?.url.includes('openai.com') && calls[1]?.url.includes('pollinations.ai'));

  const dead = scripted(() => json({ error: { message: 'down' } }, 500));
  const error = await chatJson({ ai: both(), system: 's', user: 'u', parse: (v) => v, fetchFn: dead.fetchFn }).catch((e: unknown) => e);
  assert.ok(error instanceof LlmError);
  assert.ok(!String((error as Error).message).includes(OPENAI) && !String((error as Error).message).includes(POLL));
});

test('chatJson gives the model one corrective retry for invalid JSON', async () => {
  let n = 0;
  const { fetchFn, calls } = scripted(() => reply(++n === 1 ? '{"bad":1}' : '{"good":1}'));
  const out = await chatJson({
    ai: aiConfigFromEnv({ OPENAI_API_KEY: OPENAI }), system: 's', user: 'u', fetchFn,
    parse: (v) => {
      if (!('good' in (v as object))) throw new Error('needs good');
      return v;
    },
  });
  assert.deepEqual(out, { good: 1 });
  const second = calls[1]?.body?.['messages'] as Array<{ role: string; content: string }>;
  assert.match(second.at(-1)?.content ?? '', /needs good/);
});

const PNG_OR_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const request = (dir: string, name = 'a.jpg') => ({ prompt: 'a shopkeeper', outPath: join(dir, name), width: 1088, height: 1088, seed: 7 });

test('a picture from OpenAI is requested as a square JPEG at the chosen quality and saved from base64', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-test-'));
  try {
    const { fetchFn, calls } = scripted(() => json({ data: [{ b64_json: PNG_OR_JPEG.toString('base64') }] }));
    const used = await generateScene(both(), request(dir), { openaiImages: 0 }, fetchFn);
    assert.equal(used, 'OpenAI');
    assert.equal(calls[0]?.url, 'https://api.openai.com/v1/images/generations');
    assert.deepEqual(calls[0]?.body, { model: 'gpt-image-2.5-sunburst', prompt: 'a shopkeeper', n: 1, size: '1024x1024', quality: 'medium', output_format: 'jpeg' });
    assert.deepEqual(await readFile(join(dir, 'a.jpg')), PNG_OR_JPEG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a picture falls back to Pollinations when OpenAI refuses, and the image limit stops OpenAI spending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-test-'));
  try {
    const refuse = scripted((url) => (url.includes('openai.com') ? json({ error: { message: 'content_policy_violation' } }, 400) : new Response(PNG_OR_JPEG, { headers: { 'content-type': 'image/jpeg' } })));
    assert.equal(await generateScene(both(), request(dir), { openaiImages: 0 }, refuse.fetchFn), 'Pollinations');
    assert.ok(refuse.calls[0]?.url.includes('openai.com') && refuse.calls[1]?.url.includes('pollinations.ai'));

    const limited = scripted((url) => (url.includes('openai.com') ? json({ data: [{ b64_json: PNG_OR_JPEG.toString('base64') }] }) : new Response(PNG_OR_JPEG, { headers: { 'content-type': 'image/jpeg' } })));
    const budget = { openaiImages: 0 };
    const small = aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL, OPENAI_MAX_IMAGES_PER_RUN: '1', AI_FALLBACK: 'on' });
    assert.equal(await generateScene(small, request(dir, '1.jpg'), budget, limited.fetchFn), 'OpenAI');
    assert.equal(await generateScene(small, request(dir, '2.jpg'), budget, limited.fetchFn), 'Pollinations');
    assert.equal(budget.openaiImages, 1);

    const noBackup = aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, OPENAI_MAX_IMAGES_PER_RUN: '1' });
    await assert.rejects(generateScene(noBackup, request(dir, '3.jpg'), { openaiImages: 1 }, limited.fetchFn), /limit/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a picture failure says what failed without printing any key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-test-'));
  try {
    const { fetchFn } = scripted(() => json({ error: { message: 'bad request' } }, 400));
    const error = await generateScene(aiConfigFromEnv({ OPENAI_API_KEY: OPENAI }), request(dir), { openaiImages: 0 }, fetchFn).catch((e: unknown) => e);
    assert.match(String((error as Error).message), /OpenAI.*400.*bad request/);
    assert.ok(!String((error as Error).message).includes(OPENAI));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a key quoted back by the provider is blanked out of every error', async () => {
  const quoted = scripted(() => json({ error: { message: `Incorrect API key provided: ${OPENAI}. You can find your key at ...` } }, 401));
  const textError = (await chatJson({ ai: aiConfigFromEnv({ OPENAI_API_KEY: OPENAI }), system: 's', user: 'u', parse: (v) => v, fetchFn: quoted.fetchFn }).catch((e: unknown) => e)) as Error;
  assert.ok(!textError.message.includes(OPENAI), textError.message);
  const dir = await mkdtemp(join(tmpdir(), 'ai-test-'));
  try {
    const imageError = (await generateScene(aiConfigFromEnv({ OPENAI_API_KEY: OPENAI }), request(dir), { openaiImages: 0 }, quoted.fetchFn).catch((e: unknown) => e)) as Error;
    assert.ok(!imageError.message.includes(OPENAI), imageError.message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the free backup is used only when AI_FALLBACK=on says so, even with both keys set', () => {
  assert.equal(aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL }).fallback, false);
  assert.equal(aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL, AI_FALLBACK: 'off' }).fallback, false);
  assert.equal(aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL, AI_FALLBACK: 'on' }).fallback, true);
  assert.throws(() => aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, AI_FALLBACK: 'on' }), /AI_FALLBACK=on needs/);
  assert.throws(() => aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL, AI_FALLBACK: 'maybe' }), /AI_FALLBACK must be/);
});

test('with no backup a failed paid request fails loudly and the free provider is never called', async () => {
  const noBackup = aiConfigFromEnv({ OPENAI_API_KEY: OPENAI, POLLINATIONS_API_KEY: POLL });
  const refused = scripted(() => json({ error: { message: 'You have no credits remaining.' } }, 402));
  const text = await chatJson({ ai: noBackup, system: 's', user: 'u', parse: (v) => v, fetchFn: refused.fetchFn }).catch((e: unknown) => e);
  assert.match(String((text as Error).message), /OpenAI.*402.*no credits/);
  assert.ok(refused.calls.every((c) => c.url.includes('openai.com')));

  const dir = await mkdtemp(join(tmpdir(), 'ai-test-'));
  try {
    const picture = await generateScene(noBackup, request(dir), { openaiImages: 0 }, refused.fetchFn).catch((e: unknown) => e);
    assert.match(String((picture as Error).message), /OpenAI.*402.*no credits/);
    assert.ok(refused.calls.every((c) => c.url.includes('openai.com')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('when an allowed backup does answer it says so at once, and the records show what was asked for and what answered', async () => {
  const warnings: string[] = [];
  const ai = both();
  ai.warn = (message) => warnings.push(message);
  const dir = await mkdtemp(join(tmpdir(), 'ai-test-'));
  try {
    const down = scripted((url) => (url.includes('openai.com') ? json({ error: { message: 'You have no credits remaining.' } }, 402) : url.includes('chat/completions') ? reply('{"ok":1}') : new Response(PNG_OR_JPEG, { headers: { 'content-type': 'image/jpeg' } })));
    await chatJson({ ai, system: 's', user: 'u', parse: (v) => v, fetchFn: down.fetchFn });
    ai.usage.post = 'acme-w01-d1';
    assert.equal(await generateScene(ai, request(dir), { openaiImages: 0 }, down.fetchFn), 'Pollinations');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? '', /OpenAI gpt-6-luna.*no credits.*Pollinations/s);
  assert.match(warnings[1] ?? '', /OpenAI gpt-image-2\.5-sunburst.*Pollinations/s);

  const records = ai.usage.records('acme', []);
  assert.ok(records.length === 2 && records.every((r) => r.fallback === true));
  assert.match(records[0]?.requestedModel ?? '', /^OpenAI gpt-6-luna$/);
  assert.match(records[1]?.requestedModel ?? '', /^OpenAI gpt-image-2\.5-sunburst$/);
  assert.match(records[1]?.fallbackReason ?? '', /402/);
  assert.match(ai.usage.format(), /FALLBACK/i);
});

test('a run that used no backup has no fallback marks', async () => {
  const ai = both();
  const ok = scripted(() => reply('{"ok":1}'));
  await chatJson({ ai, system: 's', user: 'u', parse: (v) => v, fetchFn: ok.fetchFn });
  assert.ok(ai.usage.records('acme', []).every((r) => r.fallback === undefined && r.requestedModel === undefined));
  assert.doesNotMatch(ai.usage.format(), /FALLBACK/i);
});
