import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { buildFullPosterPrompt, compareText, estimatePosterCost, generateFullPoster, logoReferenceType, readPosterText, type FullPosterInput } from './ai-poster.ts';
import { planExperiment } from './ai-poster-test.ts';
import type { PlannedPost } from './content.ts';

const input: FullPosterInput = { headline: 'From goals and audience to a website', fact: 'We translate these insights into a stunning, functional website.', brandName: 'Digibranders', colors: { background: '#FFFEF5', ink: '#292929', accent: '#FF5542' }, host: 'digibranders.com', hasLogoReference: true };
const ai = () => aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-123456' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('the prompt asks for the exact headline, the verified fact and the brand colours, and describes no layout', () => {
  const prompt = buildFullPosterPrompt({ ...input, subline: 'Built around your goals.' });
  assert.match(prompt, /HEADLINE: "From goals and audience to a website"/);
  assert.match(prompt, /SUPPORTING LINE: "Built around your goals\."/);
  assert.match(prompt, /We translate these insights into a stunning, functional website/);
  for (const colour of ['#FFFEF5', '#292929', '#FF5542']) assert.match(prompt, new RegExp(colour));
  assert.match(prompt, /attached logo image exactly/);
  assert.match(prompt, /no extra claims/);
  assert.doesNotMatch(prompt, /verified/i, 'a statement the customer wrote is never called verified in the picture prompt');
  assert.doesNotMatch(prompt, /rectangle|zone|panel|slot|column|grid|layout family|\d+ ?px|\d+%/i, 'no template geometry reaches the model');
  assert.doesNotMatch(buildFullPosterPrompt({ ...input, hasLogoReference: false }), /attached logo/);
});

test('without a subline the prompt names no supporting line', () => {
  assert.doesNotMatch(buildFullPosterPrompt(input), /SUPPORTING LINE/);
});

test('a text comparison finds an exact headline and spots changed or extra words', () => {
  const expected = { headline: 'From goals and audience to a website', brandName: 'Digibranders', host: 'digibranders.com' };
  const exact = compareText(expected, ['FROM GOALS AND AUDIENCE TO A WEBSITE', 'Digibranders', 'digibranders.com']);
  assert.equal(exact.headlineExact, true);
  assert.deepEqual(exact.extraWords, []);
  const misspelt = compareText(expected, ['From goals and audiance to a webste', 'Digibranders']);
  assert.equal(misspelt.headlineExact, false);
  assert.deepEqual(misspelt.extraWords.sort(), ['audiance', 'webste']);
  const invented = compareText(expected, ['From goals and audience to a website', 'Trusted by 500 brands']);
  assert.equal(invented.headlineExact, true);
  assert.ok(invented.extraWords.includes('trusted') && invented.extraWords.includes('500'), 'an invented claim shows up as extra words');
  assert.equal(compareText({ ...expected, subline: 'Built around you' }, ['From goals and audience to a website']).sublineExact, false);
});

test('only a png, jpeg or webp logo can be attached; an svg or nothing cannot', () => {
  assert.equal(logoReferenceType('/x/logo.png'), 'image/png');
  assert.equal(logoReferenceType('/x/logo.JPG'), 'image/jpeg');
  assert.equal(logoReferenceType('/x/logo.svg'), undefined);
  assert.equal(logoReferenceType(undefined), undefined);
});

test('a complete poster is requested from OpenAI as a single square, written to the file, and priced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aiposter-'));
  try {
    const config = ai();
    let call: { url: string; body: Record<string, unknown> } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      call = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 400, output_tokens: 1200 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const budget = { openaiImages: 0 };
    const out = join(dir, 'poster.jpg');
    await generateFullPoster(config, { prompt: 'a poster', outPath: out }, budget, fetchFn);
    assert.match(call?.url ?? '', /images\/generations$/);
    assert.equal(call?.body['size'], '1024x1024');
    assert.equal(call?.body['model'], config.imageModel);
    assert.deepEqual(await readFile(out), PNG);
    assert.equal(budget.openaiImages, 1);
    assert.ok(config.usage.summary().totalUsd > 0);
    assert.ok(estimatePosterCost({ imageQuality: 'medium' }) > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('with a raster logo the edit endpoint is used and the logo travels as the reference image', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aiposter-'));
  try {
    const logo = join(dir, 'logo.png');
    await writeFile(logo, PNG);
    let seen: { url: string; form: FormData } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, form: init.body as FormData };
      return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await generateFullPoster(ai(), { prompt: 'a poster', outPath: join(dir, 'p.jpg'), logoPath: logo }, { openaiImages: 0 }, fetchFn);
    assert.match(seen?.url ?? '', /images\/edits$/);
    assert.equal(seen?.form.get('prompt'), 'a poster');
    assert.ok(seen?.form.get('image') instanceof Blob);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed request, no picture in the answer, a missing key and the per-run limit are all reported, never swallowed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aiposter-'));
  try {
    const out = join(dir, 'p.jpg');
    const failing = (async () => new Response(JSON.stringify({ error: { message: 'bad key sk-secret-value-1234' } }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(generateFullPoster(ai(), { prompt: 'x', outPath: out }, { openaiImages: 0 }, failing), (error: Error) => /401/.test(error.message) && !/secret-value/.test(error.message));
    const empty = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(generateFullPoster(ai(), { prompt: 'x', outPath: out }, { openaiImages: 0 }, empty), /no picture/);
    await assert.rejects(generateFullPoster({ ...ai(), openaiKey: undefined } as never, { prompt: 'x', outPath: out }, { openaiImages: 0 }, empty), /OpenAI key/);
    const config = ai();
    await assert.rejects(generateFullPoster(config, { prompt: 'x', outPath: out }, { openaiImages: config.maxOpenAiImages }, empty), /limit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the text on the poster is read by a vision request and returned as a list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aiposter-'));
  try {
    const picture = join(dir, 'p.jpg');
    await writeFile(picture, PNG);
    let sawImage = false;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: unknown }> };
      sawImage = JSON.stringify(body.messages).includes('data:image/jpeg;base64,');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: ['From goals', '  ', 'digibranders.com'] }) } }], usage: { prompt_tokens: 1500, completion_tokens: 30 } }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual(await readPosterText(ai(), picture, fetchFn), ['From goals', 'digibranders.com']);
    assert.equal(sawImage, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the experiment plan takes the approved headline and verified fact from the post, with the brand colours, and calls no model', () => {
  const post = { id: 'p1', headline: 'From |goals and audience| to a website', subline: '', factIds: ['f1'], date: '', painPoint: '', mode: 'ai', caption: '', hashtags: [] } as unknown as PlannedPost;
  const plan = planExperiment({ posts: [post], factText: (id) => (id === 'f1' ? 'We translate these insights into a functional website.' : undefined), brand: { name: 'Digibranders', handleUrl: 'digibranders.com', colors: input.colors }, hasLogoReference: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.input.headline, 'From goals and audience to a website');
  assert.equal(plan[0]?.input.subline, undefined);
  assert.equal(plan[0]?.input.fact, 'We translate these insights into a functional website.');
  assert.match(plan[0]?.prompt ?? '', /digibranders\.com/);
});
