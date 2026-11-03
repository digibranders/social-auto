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

const snapshot: SiteSnapshot = { origin: 'https://acme.com', pages: [{ url: 'https://acme.com/', title: 'Acme', description: 'd', text: 'Dental care. '.repeat(50) }], logoCandidates: ['https://acme.com/logo.png'], iconCandidates: ['https://acme.com/icon.png'], colors: ['#0E8C8C'], fonts: ['Inter'], pageDecisions: [] };
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

test('with no logo but a site icon, the icon is used with the name beside it, not a plain text logo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    const asked: string[] = [];
    const { brand, dir: brandDir } = await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => ({ ...snapshot, logoCandidates: [] }),
      fetchBytes: async (url: string) => {
        asked.push(url);
        return { finalUrl: url, bytes: Buffer.from([137, 80, 78, 71]), type: 'image/png' };
      },
      chatFetch: (async () => modelAnswer()) as typeof fetch,
    });
    assert.deepEqual(asked, ['https://acme.com/icon.png']);
    assert.equal(brand.logo, 'assets/logo.svg');
    const file = await readFile(join(brandDir, 'assets/logo.svg'), 'utf8');
    assert.ok(file.includes('Acme Dental'));
    assert.ok(file.includes('data:image/png;base64,iVBORw=='));
    assert.deepEqual([...(await readFile(join(brandDir, 'assets/icon.png')))], [137, 80, 78, 71]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an icon that will not download leaves the plain text logo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    const { brand, dir: brandDir } = await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => ({ ...snapshot, logoCandidates: [] }),
      fetchBytes: async () => {
        throw new Error('404');
      },
      chatFetch: (async () => modelAnswer()) as typeof fetch,
    });
    assert.equal(brand.logo, 'assets/logo.svg');
    assert.ok(!(await readFile(join(brandDir, 'assets/logo.svg'), 'utf8')).includes('data:image'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the pages that were chosen and rejected are saved with their scores and reasons, for review', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    const decisions = [
      { url: 'https://acme.com/pricing', selected: true, score: 8, reasons: ['+5 "pricing" page', '+3 in the navigation'] },
      { url: 'https://acme.com/privacy', selected: false, score: -20, reasons: ['-20 legal or utility page (privacy)'] },
    ];
    const { dir: brandDir } = await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => ({ ...snapshot, pageDecisions: decisions }),
      fetchBytes: async () => {
        throw new Error('404');
      },
      chatFetch: (async () => modelAnswer()) as typeof fetch,
    });
    const saved = JSON.parse(await readFile(join(brandDir, 'pages.json'), 'utf8')) as { read: unknown[]; skipped: Array<{ url: string; reasons: string[] }> };
    assert.deepEqual(saved.read, [decisions[0]]);
    assert.deepEqual(saved.skipped, [decisions[1]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const FACT_PAGES = [
  { url: 'https://acme.com/', title: 'Acme', description: 'd', fetchedAt: '2026-11-01T00:00:00Z', text: 'Acme Dental looks after families. We are open on Saturdays from 9 to 1. Our dentists see patients in 12 neighbourhoods. Check-ups start from $40 per visit.' },
  { url: 'https://acme.com/about', title: 'About', description: 'd', fetchedAt: '2026-11-01T00:00:00Z', text: 'Our team has cared for local families since 2008. Every visit begins with a friendly chat.' },
];
const factSnapshot = (): SiteSnapshot => ({ ...snapshot, pages: FACT_PAGES, pageDecisions: [] });
const answerWith = (proofPoints: unknown): typeof fetch => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...brandJson, visualStyle: 'Deep teal', proofPoints }) } }] }), { status: 200 })) as typeof fetch;
const runAnalyze = async (proofPoints: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    const out = await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => factSnapshot(),
      fetchBytes: async () => {
        throw new Error('404');
      },
      chatFetch: answerWith(proofPoints),
    });
    const evidence = JSON.parse(await readFile(join(out.dir, 'evidence.json'), 'utf8')) as { verified: Array<{ text: string; source: { url: string; verbatimQuote: string; contentHash: string } }>; uncertain: unknown[]; rejected: Array<{ text: string; verification: { reasons: string[] } }> };
    const saved = parseBrand(JSON.parse(await readFile(join(out.dir, 'brand.json'), 'utf8')), 'brand.json');
    return { brand: out.brand, evidence, saved };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('proof points are kept only when the site really says them, and every one is recorded with its source', async () => {
  const { brand, evidence, saved } = await runAnalyze([
    { claim: 'Open on Saturdays from 9 to 1.', sourceUrl: 'https://acme.com/', quote: 'We are open on Saturdays from 9 to 1.' },
    { claim: 'Caring for local families since 2008.', sourceUrl: 'https://acme.com/about', quote: 'Our team has cared for local families since 2008.' },
    { claim: 'Dentists in 30 neighbourhoods.', sourceUrl: 'https://acme.com/', quote: 'Our dentists see patients in 30 neighbourhoods.' },
    { claim: 'Check-ups cost $40 per visit.', sourceUrl: 'https://acme.com/', quote: 'Check-ups start from $40 per visit.' },
    { claim: 'Free parking for every patient.', sourceUrl: 'https://acme.com/', quote: 'Free parking is available for every patient.' },
  ]);
  assert.deepEqual(brand.proofPoints, ['Open on Saturdays from 9 to 1.', 'Caring for local families since 2008.']);
  assert.deepEqual(saved.proofPoints, brand.proofPoints);
  assert.deepEqual(evidence.verified.map((c) => c.text), brand.proofPoints);
  assert.ok(evidence.verified.every((c) => /^sha256:[0-9a-f]{64}$/.test(c.source.contentHash) && c.source.url.startsWith('https://acme.com')));
  assert.equal(evidence.uncertain.length, 1, 'the price that drops "start from" is held back for review');
  assert.equal(evidence.rejected.length, 2);
  assert.ok(evidence.rejected.every((c) => c.verification.reasons.length > 0));
});

test('a site with nothing that can be verified still works: the profile has no proof points and the record says why', async () => {
  const { brand, evidence } = await runAnalyze([{ claim: 'We are the best.', sourceUrl: 'https://acme.com/', quote: 'We are simply the best dentists anywhere.' }]);
  assert.deepEqual(brand.proofPoints, []);
  assert.equal(evidence.verified.length, 0);
  assert.equal(evidence.rejected.length, 1);
});

test('proof points given as plain text, with no source, are rejected as unsourced', async () => {
  const { brand, evidence } = await runAnalyze(['Open Saturdays', 'Friendly team']);
  assert.deepEqual(brand.proofPoints, []);
  assert.equal(evidence.rejected.length, 2);
  assert.ok(evidence.rejected.every((c) => c.verification.reasons.some((r) => /no source|unsourced/i.test(r))));
});

test('a saved profile may have no proof points, but still needs content rules', () => {
  assert.deepEqual(parseBrand({ ...withFiles, proofPoints: [] }, 'brand.json').proofPoints, []);
  assert.throws(() => parseBrand({ ...withFiles, rules: [] }, 'brand.json'), /rules/);
  assert.deepEqual(parseBrand(withFiles, 'brand.json').proofPoints, ['Open Saturdays']);
});
