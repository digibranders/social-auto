import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvidence } from './evidence.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';
import { FACTS_VERSION } from './evidence-pipeline.ts';
import { CopyStage } from './copy-stage.ts';
import { createReviewServer } from './review-server.ts';
import { ProductBrands } from './product-brands.ts';
import { ReviewStore } from './review-store.ts';

/**
 * The shapes a product (Brandbasket) builds its screens on. A test fails when a field is renamed or removed, so the shapes only change on purpose.
 * Run with REVIEW_V1_EXAMPLES=<file> to write the real responses of this run as the examples handed to the people building the screens.
 */
const SECRET = 'staff-secret-0123456789';
const PRODUCT = 'brandbasket-secret-0123456789';
const NOW = new Date('2026-11-06T00:00:00Z');
const block = (over: Partial<PageBlock>): PageBlock => ({ id: 'b', text: '', tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const page = (url: string, texts: string[]): PageStructure => ({ url, title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: texts.map((text, i) => block({ id: `b${i}`, text })) });
const keys = (value: unknown): string[] => Object.keys(value as object).sort();

test('the v1 shapes of the customer review flow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-v1-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  const built = buildEvidence([page('https://acme.example/features', ['Installation takes under 10 minutes and uses one script tag.', 'Answers come from your own pages and documents.'])], NOW);
  writeFileSync(join(dir, 'facts.json'), JSON.stringify({ version: FACTS_VERSION, builtAt: NOW.toISOString(), site: 'https://acme.example', facts: built.facts, conflicts: [], snapshots: [], coverage: { pages: 1, structured: 1, flatText: 0, usable: built.facts.length, needsReview: 0, excluded: 0, notes: [] } }));
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Acme Replies', website: 'https://acme.example', handleUrl: 'acme.example', offer: 'A support chatbot', audience: 'Small websites', tone: 'Warm and plain', proofPoints: ['one script tag'], callToAction: 'Try it', rules: ['keep it plain'], colors: { background: '#FCFBF9', ink: '#102234', accent: '#E9AF88', tile: '#0C1E2E' }, font: 'Inter', logo: 'logo.png', mark: 'A', features: [] }));
  new ProductBrands(brandsRoot).claim('bb-acme', 'brandbasket', () => false);
  new CopyStage(dir, 'bb-acme').open('week-01.json', [{ postId: 'w01-d1', headline: 'Answers from your own docs', caption: 'Your docs already know the answer. (link in bio)', captions: { instagram: { text: 'Your docs already know the answer. (link in bio)' }, linkedin: { text: 'Your docs already know the answer. Set it up in minutes.' } } }]);
  const picture = join(root, 'p.jpg');
  writeFileSync(picture, 'picture');
  const version = new ReviewStore(dir, 'bb-acme').addVersion({
    postId: 'w01-d1', planFile: 'week-01.json', network: 'instagram', width: 1080, height: 1350, headline: 'Answers from your own docs', caption: 'Your docs already know the answer. (link in bio)', ctaUrl: 'https://acme.example', factIds: ['f1'],
    evidence: [{ factId: 'f1', text: 't', quote: 'q', url: 'https://acme.example/', context: 'c' }], imagePath: picture, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016,
  });
  const server = createReviewServer({ brandsRoot, secret: SECRET, jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: PRODUCT }] });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, init: { body?: unknown; method?: string } = {}): Promise<Record<string, any>> => {
    const res = await fetch(`${base}${path}`, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    assert.equal(res.status < 300, true, `${path} answered ${res.status}`);
    return (await res.json()) as Record<string, any>;
  };
  try {
    const copy = await get('/review/copy');
    assert.deepEqual(keys(copy), ['batches', 'networkRules']);
    const batch = copy['batches'][0];
    assert.deepEqual(batch.networks, ['instagram', 'linkedin'], 'the networks the batch is written for');
    assert.deepEqual(keys(batch.posts[0]).filter((k) => ['postId', 'headline', 'caption', 'captions', 'state', 'contentHash'].includes(k)), ['caption', 'captions', 'contentHash', 'headline', 'postId', 'state']);
    assert.deepEqual(keys(batch.posts[0].captions.instagram), ['text']);

    const facts = await get('/review/brands/bb-acme/facts');
    assert.deepEqual(keys(facts), ['brand', 'builtAt', 'counts', 'facts', 'mode', 'profile']);
    assert.deepEqual(keys(facts['facts'][0]), ['factId', 'held', 'sourceQuote', 'sourceUrl', 'state', 'text']);

    const versions = await get('/review/posts?status=pending');
    assert.deepEqual(keys(versions), ['problems', 'posts', 'reasons'].sort());
    assert.deepEqual(keys(versions['posts'][0]), ['brand', 'canRedraw', 'caption', 'costUsd', 'createdAt', 'headline', 'imageSha256', 'network', 'planFile', 'postId', 'redrawsLeft', 'shape', 'status', 'height', 'versionId', 'versionNumber', 'width'].sort());
    assert.equal(versions['posts'][0].shape, 'tall');
    assert.match(versions['posts'][0].imageSha256, /^[0-9a-f]{64}$/, 'versions of the same drawing share this hash');

    const approved = await get(`/review/posts/${version.versionId}/approve`, { body: {} });
    assert.deepEqual(keys(approved), ['decision', 'status']);
    assert.equal(approved['status'], 'approved');
    const detail = await get(`/review/posts/${version.versionId}`);
    assert.ok(detail['history'] && detail['version'] && detail['decision']);
    assert.equal(detail['decision'].by, 'brandbasket:user-42');

    if (process.env['REVIEW_V1_EXAMPLES']) writeFileSync(process.env['REVIEW_V1_EXAMPLES'], `${JSON.stringify({ copyList: copy, facts, versions, approve: approved, versionDetail: detail }, null, 2)}\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
