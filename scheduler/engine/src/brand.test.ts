import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { analyzeSite, textLogoSvg } from './analyze.ts';
import { parseBrand } from './content.ts';
import { scenePrompt } from './planner.ts';
import type { SiteSnapshot } from './crawl.ts';

const brandJson = {
  name: 'Acme Dental', website: 'https://acme.com', handleUrl: 'acme.com', offer: 'Dental care for families', audience: 'Families', tone: 'Warm',
  proofPoints: ['Open Saturdays'], callToAction: 'Book at acme.com (link in bio)', rules: ['No invented prices'],
  colors: { background: '#F4FAFA', ink: '#12303A', accent: '#0E8C8C', tile: '#0B5A5A' }, font: 'Inter',
  features: [{ icon: 'person', title: 'Family care', detail: 'All ages welcome' }],
};
const withFiles = { ...brandJson, logo: 'assets/logo.svg', mark: 'assets/logo.svg' };

test('a brand profile may carry a visual style sentence, and it must be text', () => {
  assert.equal(parseBrand({ ...withFiles, visualStyle: 'Deep teal and white, bright clinic interiors' }, 't').visualStyle, 'Deep teal and white, bright clinic interiors');
  assert.equal(parseBrand(withFiles, 't').visualStyle, undefined);
  assert.throws(() => parseBrand({ ...withFiles, visualStyle: 5 }, 't'), /visualStyle/);
});

test('the picture prompt carries the brand visual style when there is one, and is unchanged when there is not', () => {
  const plain = scenePrompt('A patient smiling in a chair.', 'left', {}, false);
  assert.ok(!plain.includes('Visual style'));
  assert.match(plain, /^A patient smiling in a chair, /);
  const styled = scenePrompt('A patient smiling in a chair.', 'left', { visualStyle: 'Deep teal and white. Bright clinic interiors.' }, false);
  assert.match(styled, /^A patient smiling in a chair\. Visual style: Deep teal and white\. Bright clinic interiors, /);
  assert.match(styled, /no text, no letters/);
});

test('the text logo shows the name in the brand colours, with anything odd in the name made safe', () => {
  const svg = textLogoSvg('Acme <Dental> & Co', { ink: '#12303A', accent: '#0E8C8C' });
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('Acme &lt;Dental&gt; &amp; Co'));
  assert.ok(svg.includes('#0E8C8C') && svg.includes('#12303A'));
  assert.ok(!svg.includes('<Dental>'));
  assert.ok(textLogoSvg('x'.repeat(80), { ink: '#000000', accent: '#111111' }).includes('x'.repeat(24)));
});

const snapshot: SiteSnapshot = { origin: 'https://acme.com', pages: [{ url: 'https://acme.com/', title: 'Acme', description: 'd', text: 'Dental care. '.repeat(50) }], logoCandidates: ['https://acme.com/logo.png'], colors: ['#0E8C8C'], fonts: ['Inter'] };
const modelAnswer = (): Response => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...brandJson, visualStyle: 'Deep teal and white' }) } }] }), { status: 200 });

test('when no logo can be downloaded the brand still gets one: its name as a text logo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    const { brand, dir: brandDir } = await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => snapshot,
      fetchBytes: async () => {
        throw new Error('404');
      },
      chatFetch: (async () => modelAnswer()) as typeof fetch,
    });
    assert.equal(brand.logo, 'assets/logo.svg');
    assert.equal(brand.visualStyle, 'Deep teal and white');
    const file = await readFile(join(brandDir, 'assets/logo.svg'), 'utf8');
    assert.ok(file.includes('Acme Dental'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a logo that downloads is kept as the logo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    const { brand, dir: brandDir } = await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => snapshot,
      fetchBytes: async () => ({ finalUrl: 'https://acme.com/logo.png', bytes: Buffer.from([1, 2, 3]), type: 'image/png' }),
      chatFetch: (async () => modelAnswer()) as typeof fetch,
    });
    assert.equal(brand.logo, 'assets/logo.png');
    assert.deepEqual([...(await readFile(join(brandDir, 'assets/logo.png')))], [1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
