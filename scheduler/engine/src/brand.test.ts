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

const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
const analyzeWith = async (crawlOver: Partial<SiteSnapshot>, fetchBytes: (url: string) => Promise<{ finalUrl: string; bytes: Buffer; type: string }>) => {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    const out = await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => ({ ...snapshot, ...crawlOver }),
      fetchBytes,
      chatFetch: (async () => modelAnswer()) as typeof fetch,
    });
    return { brand: out.brand, saved: JSON.parse(await readFile(join(out.dir, 'brand.json'), 'utf8')) as { logoSource?: unknown } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('the profile records where the logo came from: page, exact address, hash, time and every address tried', async () => {
  const { brand, saved } = await analyzeWith({ logoCandidates: ['https://acme.com/promo.png', 'https://acme.com/logo.png'] }, async (url) => {
    if (url.endsWith('promo.png')) throw new Error('404');
    return { finalUrl: url, bytes: png, type: 'image/png' };
  });
  const source = brand.logoSource;
  assert.ok(source);
  assert.equal(source.kind, 'site-logo');
  assert.equal(source.foundOn, 'https://acme.com');
  assert.equal(source.imageUrl, 'https://acme.com/logo.png');
  assert.equal(source.savedAs, 'assets/logo.png');
  assert.equal(source.contentType, 'image/png');
  assert.equal(source.bytes, png.length);
  assert.match(source.contentHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(source.fetchedAt)));
  assert.deepEqual(source.tried.map((t) => [t.url, t.outcome]), [['https://acme.com/promo.png', 'failed: 404'], ['https://acme.com/logo.png', 'used']]);
  assert.deepEqual(saved.logoSource, JSON.parse(JSON.stringify(source)));
});

test('a logo made from the site icon says so, with the icon address and what was tried first', async () => {
  const { brand } = await analyzeWith({ logoCandidates: ['https://acme.com/banner.png'] }, async (url) => {
    if (url.includes('banner')) return { finalUrl: url, bytes: Buffer.from('<html>'), type: 'text/html' };
    return { finalUrl: url, bytes: png, type: 'image/png' };
  });
  assert.equal(brand.logoSource?.kind, 'site-icon');
  assert.equal(brand.logoSource?.imageUrl, 'https://acme.com/icon.png');
  assert.equal(brand.logoSource?.savedAs, 'assets/icon.png');
  assert.deepEqual(brand.logoSource?.tried.map((t) => [t.url, t.outcome]), [['https://acme.com/banner.png', 'failed: not an image (text/html)'], ['https://acme.com/icon.png', 'used']]);
});

test('a name-only logo is recorded as such, with no image address', async () => {
  const { brand } = await analyzeWith({}, async () => {
    throw new Error('timeout');
  });
  assert.equal(brand.logoSource?.kind, 'name-only');
  assert.equal(brand.logoSource?.imageUrl, null);
  assert.equal(brand.logoSource?.contentHash, null);
  assert.equal(brand.logoSource?.tried.length, 2);
});

test('older profiles without a logo source still load, and a malformed one is refused', () => {
  assert.equal(parseBrand(withFiles, 'brand.json').logoSource, undefined);
  const source = { kind: 'site-logo', foundOn: 'https://acme.com', imageUrl: 'https://acme.com/logo.png', savedAs: 'assets/logo.png', contentType: 'image/png', bytes: 7, contentHash: 'sha256:abc', fetchedAt: '2026-11-03T00:00:00Z', tried: [{ url: 'https://acme.com/logo.png', outcome: 'used' }] };
  assert.deepEqual(parseBrand({ ...withFiles, logoSource: source }, 'brand.json').logoSource, source);
  assert.throws(() => parseBrand({ ...withFiles, logoSource: { ...source, kind: 'stolen' } }, 'brand.json'), /logoSource/);
  assert.throws(() => parseBrand({ ...withFiles, logoSource: 'x' }, 'brand.json'), /logoSource/);
});

const identityAnswer = (extra: object): (() => Response) => () =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...brandJson, callToAction: 'Book at acme.com (link in bio)', ...extra }) } }] }), { status: 200 });
const identitySnapshot: SiteSnapshot = {
  ...snapshot,
  pages: [{ url: 'https://acme.com/', title: 'Acme Dental', description: 'Family dental care in town', text: 'Family dental care for the whole town. '.repeat(10), fetchedAt: '2026-11-01T00:00:00Z' }],
  links: [{ url: 'https://acme.com/pricing', text: 'Pricing', region: 'nav' }],
};
const analyzeIdentity = async (answer: () => Response, over: Partial<SiteSnapshot> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    const out = await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => ({ ...identitySnapshot, ...over }),
      fetchBytes: async (url: string) => ({ finalUrl: url, bytes: png, type: 'image/png' }),
      chatFetch: (async () => answer()) as typeof fetch,
    });
    return { brand: out.brand, saved: JSON.parse(await readFile(join(out.dir, 'brand.json'), 'utf8')) as Record<string, unknown> };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('the identity line is read from the site with its quote, stored apart from the claims, and saved in the profile', async () => {
  const { brand, saved } = await analyzeIdentity(identityAnswer({ identityCandidates: [{ line: 'Family dental care for the whole town', sourceUrl: 'https://acme.com/', quote: 'Family dental care for the whole town.' }] }));
  assert.equal(brand.identity?.kind, 'homepage');
  assert.equal(brand.identity?.line, 'Family dental care for the whole town');
  assert.equal(brand.identity?.verification.status, 'verified');
  assert.deepEqual(saved['identity'], JSON.parse(JSON.stringify(brand.identity)));
});

test('an identity the site does not support falls back to the brand name alone', async () => {
  const { brand } = await analyzeIdentity(identityAnswer({ identityCandidates: [{ line: 'The leading dental group in the country', sourceUrl: 'https://acme.com/', quote: 'The leading dental group in the country' }] }));
  assert.equal(brand.identity?.kind, 'name-only');
  assert.equal(brand.identity?.line, 'Acme Dental');
});

test('the page title and description count as the last rung of the ladder', async () => {
  const { brand } = await analyzeIdentity(identityAnswer({ identityCandidates: [{ line: 'Family dental care in town', sourceUrl: 'metadata:https://acme.com', quote: 'Family dental care in town' }] }), {
    pages: [{ url: 'https://acme.com/', title: 'Acme Dental', description: 'Family dental care in town', text: 'Welcome. '.repeat(40), fetchedAt: '2026-11-01T00:00:00Z' }],
  });
  assert.equal(brand.identity?.kind, 'metadata');
});

test('the call to action comes from a real link of the site, not from the model, and its evidence is saved', async () => {
  const { brand, saved } = await analyzeIdentity(identityAnswer({ identityCandidates: [] }));
  assert.equal(brand.callToAction, 'See pricing at acme.com (link in bio)');
  assert.equal(brand.cta?.kind, 'site-action');
  assert.equal(brand.cta?.evidence?.url, 'https://acme.com/pricing');
  assert.deepEqual(saved['cta'], JSON.parse(JSON.stringify(brand.cta)));
});

test('a site with no recognisable action gets "Visit" and its real address', async () => {
  const { brand } = await analyzeIdentity(identityAnswer({ identityCandidates: [] }), { links: [{ url: 'https://acme.com/people', text: 'Our people', region: 'nav' }] });
  assert.equal(brand.callToAction, 'Visit acme.com (link in bio)');
  assert.equal(brand.cta?.kind, 'visit-site');
});

test('the brand reader is asked for identity candidates and no longer writes the call to action', async () => {
  const asked: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'analyze-test-'));
  try {
    await analyzeSite('acme.com', dir, aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-1234' }), {
      crawl: async () => identitySnapshot,
      fetchBytes: async (url: string) => ({ finalUrl: url, bytes: png, type: 'image/png' }),
      chatFetch: (async (_url: string, init?: RequestInit) => {
        asked.push(String(init?.body));
        return identityAnswer({ identityCandidates: [] })();
      }) as typeof fetch,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.match(asked[0] ?? '', /\\"identityCandidates\\"/);
  assert.match(asked[0] ?? '', /metadata:https:\/\/acme\.com/);
  assert.ok(!/short call to action/.test(asked[0] ?? ''));
});

test('profiles saved before identity and call-to-action records still load, and malformed records are refused', () => {
  assert.equal(parseBrand(withFiles, 'brand.json').identity, undefined);
  const identity = { line: 'Acme', kind: 'name-only', source: null, verification: { status: 'unverified', reasons: ['x'] } };
  assert.deepEqual(parseBrand({ ...withFiles, identity }, 'brand.json').identity, identity);
  assert.throws(() => parseBrand({ ...withFiles, identity: { ...identity, kind: 'invented' } }, 'brand.json'), /identity/);
  const cta = { kind: 'visit-site', label: 'Visit the website', evidence: null, text: 'Visit acme.com (link in bio)' };
  assert.deepEqual(parseBrand({ ...withFiles, cta }, 'brand.json').cta, cta);
  assert.throws(() => parseBrand({ ...withFiles, cta: { ...cta, kind: 'x' } }, 'brand.json'), /cta/);
});
