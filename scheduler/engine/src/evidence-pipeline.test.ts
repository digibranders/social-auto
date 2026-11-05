import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SiteSnapshot } from './crawl.ts';
import { buildSiteFacts, FACTS_FILE, loadFacts, writeFacts } from './evidence-pipeline.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';

const NOW = new Date('2026-11-04T00:00:00Z');
const block = (over: Partial<PageBlock>): PageBlock => ({ id: 'b', text: '', tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const structureFor = (url: string, texts: string[], unstyled = false): PageStructure => ({ url, title: '', lang: 'en', truncated: false, unstyled, variantSwitch: false, htmlHash: 'sha256:x', blocks: texts.map((text, i) => block({ id: `b${i}`, text })) });

const snapshot = (): SiteSnapshot => ({
  origin: 'https://acme.example', pages: [{ url: 'https://acme.example/', title: '', description: '', text: 'Home text for Acme Replies, a support chatbot.' }, { url: 'https://acme.example/pricing', title: '', description: '', text: 'The Pro plan costs 999 per month.' }],
  logoCandidates: [], iconCandidates: [], colors: [], fonts: [], pageDecisions: [], stylesheets: ['.x{color:red}'],
  sources: [{ url: 'https://acme.example/', html: '<p>home</p>' }, { url: 'https://acme.example/pricing', html: '<p>pricing</p>' }],
});

const extractor = (calls: Array<{ url: string; styles: readonly string[] }> = []) => async (_html: string, url: string, styles: readonly string[]): Promise<PageStructure> => {
  calls.push({ url, styles });
  return structureFor(url, url.endsWith('pricing') ? ['The Pro plan costs ₹999 per month.'] : ['Acme Replies answers visitor questions from your own pages.']);
};

test('facts are built from every page read, with the homepage stylesheets applied, and counted', async () => {
  const calls: Array<{ url: string; styles: readonly string[] }> = [];
  const file = await buildSiteFacts(snapshot(), { extract: extractor(calls), now: NOW });
  assert.equal(file.coverage.pages, 2);
  assert.equal(file.coverage.structured, 2);
  assert.equal(file.coverage.flatText, 0);
  assert.equal(file.coverage.usable, 2);
  assert.deepEqual(calls.map((c) => c.styles), [['.x{color:red}'], ['.x{color:red}']]);
  assert.equal(file.snapshots.length, 2);
  assert.equal(file.site, 'https://acme.example');
});

test('a page whose structure cannot be read falls back to flat text with every fact held, and says so', async () => {
  const failing = async (_html: string, url: string): Promise<PageStructure> => {
    if (url.endsWith('pricing')) throw new Error('Chrome is not installed');
    return structureFor(url, ['Acme Replies answers visitor questions from your own pages.']);
  };
  const file = await buildSiteFacts(snapshot(), { extract: failing, now: NOW });
  assert.equal(file.coverage.structured, 1);
  assert.equal(file.coverage.flatText, 1);
  assert.ok(file.coverage.notes.some((n) => /pricing/.test(n) && /Chrome is not installed/.test(n)));
  const pricing = file.facts.filter((f) => f.source.url.endsWith('pricing'));
  assert.ok(pricing.length > 0 && pricing.every((f) => f.status === 'needs_review' && f.reasonCodes.includes('flat_text_only')));
  assert.ok(file.facts.some((f) => f.status === 'usable' && !f.source.url.endsWith('pricing')));
});

test('a page read without its stylesheets is noted', async () => {
  const unstyled = async (_h: string, url: string): Promise<PageStructure> => structureFor(url, ['Acme Replies answers visitor questions from your own pages.'], true);
  const file = await buildSiteFacts(snapshot(), { extract: unstyled, now: NOW });
  assert.ok(file.coverage.notes.some((n) => /stylesheets were not available/.test(n)));
});

test('facts are saved next to the profile, read back, and old commercial facts are held when read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'facts-'));
  try {
    assert.equal(await loadFacts(dir), null);
    const file = await buildSiteFacts(snapshot(), { extract: extractor(), now: NOW });
    const path = await writeFacts(dir, file);
    assert.equal(path, join(dir, FACTS_FILE));
    const fresh = await loadFacts(dir, { now: new Date('2026-11-10T00:00:00Z') });
    assert.equal(fresh?.facts.filter((f) => f.status === 'usable').length, 2);
    const later = await loadFacts(dir, { now: new Date('2027-01-15T00:00:00Z') });
    const price = later?.facts.find((f) => f.text.includes('₹999'));
    assert.equal(price?.status, 'needs_review');
    assert.ok(price?.reasonCodes.includes('stale_commercial_term'));
    assert.equal(later?.facts.find((f) => f.text.includes('answers visitor questions'))?.status, 'usable');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a damaged or wrong-version facts file is an error, never silently legacy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'facts-'));
  try {
    await writeFile(join(dir, FACTS_FILE), '{broken');
    await assert.rejects(loadFacts(dir), /not valid JSON/);
    await writeFile(join(dir, FACTS_FILE), JSON.stringify({ version: 99, facts: [] }));
    await assert.rejects(loadFacts(dir), /wrong shape or version/);
    const file = await buildSiteFacts(snapshot(), { extract: extractor(), now: NOW });
    await writeFile(join(dir, FACTS_FILE), JSON.stringify({ ...file, facts: [{ id: 1 }] }));
    await assert.rejects(loadFacts(dir), /wrong shape or version/);
    assert.match(await readFile(join(dir, FACTS_FILE), 'utf8'), /"id": ?1|"id":1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
