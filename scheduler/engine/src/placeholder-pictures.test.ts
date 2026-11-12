import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aiConfigFromEnv } from './ai.ts';
import { makeCreatives } from './ai-creative-pipeline.ts';
import { buildCreativePrompt } from './ai-creative.ts';
import type { Brand, PlannedPost } from './content.ts';
import { NETWORK_RULES, NETWORKS } from './networks.ts';
import { defaultBudgetLimits, PaidLedger } from './paid-ledger.ts';
import { placeholderDeps, placeholderEnabled, placeholderHtml, textsOfPrompt, networkOfPrompt } from './placeholder-pictures.ts';
import type { RunFn } from './chrome-render.ts';
import { CANVAS_SIZE } from './layout.ts';

const brand = { name: 'Acme', website: 'https://www.acme.example', colors: { background: '#FFFFFF', ink: '#111111', accent: '#6B3FD4', tile: '#EEEEEE' } } as unknown as Brand;
const post = (id: string, headline: string): PlannedPost => ({ id, headline }) as unknown as PlannedPost;

/** A pretend Chrome: writes a PNG header of the canvas size where the screenshot is asked for. */
const fakeChrome: RunFn = async (_file, args) => {
  const target = args.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length) as string;
  const bytes = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(CANVAS_SIZE, 16);
  bytes.writeUInt32BE(CANVAS_SIZE, 20);
  writeFileSync(target, bytes);
  return { stdout: '' };
};

function setup(limits: Partial<typeof defaultBudgetLimits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'placeholder-'));
  const ai = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234', AI_PROVIDER: 'openai' });
  ai.ledger = new PaidLedger(join(dir, 'ledger.jsonl'), { ...defaultBudgetLimits, ...limits }, { jobId: 'job', tenantId: 'bb', brandId: 'bb-acme', now: () => new Date('2026-11-12T06:30:00Z') });
  return { dir, ai, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('placeholders are on only when both settings say so', () => {
  assert.equal(placeholderEnabled({}), false);
  assert.equal(placeholderEnabled({ PICTURE_MODE: 'placeholder' }), false, 'one setting is not enough');
  assert.equal(placeholderEnabled({ LOCAL_PLACEHOLDER_PICTURES: 'yes' }), false);
  assert.equal(placeholderEnabled({ PICTURE_MODE: 'placeholder', LOCAL_PLACEHOLDER_PICTURES: 'yes' }), true);
});

test('the texts and the network are read back from the prompt the pipeline builds, and the picture says PLACEHOLDER with its network\'s colour', () => {
  const prompt = buildCreativePrompt({ headline: 'Answers from your docs', brandName: 'Acme', domain: 'acme.example' }, { fact: 'f', colors: brand.colors, shape: NETWORK_RULES.facebook.picture, network: 'facebook' });
  assert.deepEqual(textsOfPrompt(prompt), ['Answers from your docs', 'Acme', 'acme.example']);
  assert.equal(networkOfPrompt(prompt), 'facebook');
  const html = placeholderHtml(['Answers <b>', 'acme.example'], 'facebook');
  assert.match(html, /PLACEHOLDER · FACEBOOK/);
  assert.match(html, /#1877f2/);
  assert.match(html, /Answers &lt;b&gt;/, 'text is escaped');
  const colours = NETWORKS.map((n) => placeholderHtml(['x'], n).match(/background:(#[0-9a-f]{6})/)?.[1]);
  assert.equal(new Set(colours).size, 4, 'each network has its own colour');
});

test('the normal pipeline accepts a placeholder for every network, each its own file, and the paid ledger counts them per channel at no cost', async () => {
  const s = setup();
  try {
    const drawn: string[] = [];
    for (const network of NETWORKS) {
      const made = await makeCreatives({
        ai: s.ai, brand, brandSlug: 'bb-acme', outDir: join(s.dir, `out-${network}`), shape: NETWORK_RULES[network].picture, network, factOf: () => 'Acme answers from your own documents.',
        posts: [post('p1', 'Answers from your docs')],
        deps: placeholderDeps({ ai: s.ai, chrome: { run: fakeChrome }, toJpeg: async (png, jpg) => { copyFileSync(png, jpg); } }),
      });
      assert.equal(made.results[0]?.status, 'accepted', JSON.stringify(made.results[0]));
      assert.ok(existsSync(made.results[0]?.file as string));
      drawn.push(made.results[0]?.file as string);
    }
    assert.equal(new Set(drawn).size, 4, 'one file per network');
    const used = s.ai.ledger?.channelUsage().used;
    assert.deepEqual(used, { instagram: 1, facebook: 1, linkedin: 1, google: 1 });
    assert.equal(s.ai.ledger?.spend().brandMonth, 0, 'no money is spent');
    assert.equal(s.ai.ledger?.calls().every((c) => c.model === 'placeholder' && c.status === 'completed'), true);
  } finally {
    s.done();
  }
});

test('the weekly limit still stops a channel in placeholder mode', async () => {
  const s = setup({ maxPicturesPerChannelWeek: 1 });
  try {
    const draw = (id: string) => makeCreatives({
      ai: s.ai, brand, brandSlug: 'bb-acme', outDir: join(s.dir, `out-${id}`), shape: NETWORK_RULES.instagram.picture, network: 'instagram', factOf: () => 'f',
      posts: [post(id, 'Answers from your docs')], deps: placeholderDeps({ ai: s.ai, chrome: { run: fakeChrome }, toJpeg: async (png, jpg) => { copyFileSync(png, jpg); } }),
    });
    assert.equal((await draw('p1')).results[0]?.status, 'accepted');
    const second = (await draw('p2')).results[0];
    assert.equal(second?.status, 'budget_stopped', 'the channel has no pictures left this week');
    assert.match(second?.reason ?? '', /used your 1 Instagram pictures for this week/);
  } finally {
    s.done();
  }
});
