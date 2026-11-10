import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEvidence } from './evidence.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';
import { FACTS_VERSION } from './evidence-pipeline.ts';
import { decideFact, FactsError, factsView } from './facts-view.ts';

const NOW = new Date('2026-11-06T00:00:00Z');
const block = (over: Partial<PageBlock>): PageBlock => ({ id: 'b', text: '', tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const page = (url: string, texts: string[]): PageStructure => ({ url, title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: texts.map((text, i) => block({ id: `b${i}`, text })) });

function brandDir(): { dir: string; ids: { setup: string; held: string }; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'facts-view-'));
  const built = buildEvidence([page('https://acme.example/features', ['Installation takes under 10 minutes and uses one script tag.', 'Answers come from your own pages and documents.', 'Trusted by 1,000+ agencies worldwide.'])], NOW);
  const setup = built.facts.find((f) => /Installation/.test(f.text));
  const held = built.facts.find((f) => /Trusted by/.test(f.text));
  assert.ok(setup && held, 'the fixture has the facts it needs');
  assert.ok(held.proofHold, 'a statistic is held from the automatic flow');
  writeFileSync(join(dir, 'facts.json'), JSON.stringify({ version: FACTS_VERSION, builtAt: NOW.toISOString(), site: 'https://acme.example', facts: built.facts, conflicts: [], snapshots: [], coverage: { pages: 1, structured: 1, flatText: 0, usable: built.facts.length, needsReview: 0, excluded: 0, notes: [] } }));
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Acme Replies', website: 'https://acme.example', handleUrl: 'acme.example', offer: 'A support chatbot', audience: 'Small websites', tone: 'Warm and plain', proofPoints: ['one script tag'], callToAction: 'Try it', rules: ['keep it plain'], colors: { background: '#FCFBF9', ink: '#102234', accent: '#E9AF88', tile: '#0C1E2E' }, font: 'Inter', logo: 'logo.png', mark: 'A', features: [] }));
  return { dir, ids: { setup: setup.id, held: held.id }, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const refusal = async (work: () => Promise<unknown>): Promise<string> => {
  try { await work(); } catch (error) { assert.ok(error instanceof FactsError, String(error)); return error.code; }
  return assert.fail('not refused');
};

test('the facts are listed with where they came from, and a held claim is marked held with its reason', async () => {
  const { dir, ids, done } = brandDir();
  try {
    const view = await factsView(dir, 'acme');
    assert.equal(view.mode, 'all_usable');
    assert.equal(view.profile.name, 'Acme Replies');
    const setup = view.facts.find((f) => f.factId === ids.setup);
    assert.equal(setup?.state, 'suggested');
    assert.equal(setup?.sourceUrl, 'https://acme.example/features');
    assert.ok(setup?.sourceQuote);
    const held = view.facts.find((f) => f.factId === ids.held);
    assert.equal(held?.held, true);
    assert.ok(held?.heldReason);
    assert.equal(view.counts.held, 1);
  } finally {
    done();
  }
});

test('a fact can be removed and put back, and removing does not switch the brand to confirmed-only', async () => {
  const { dir, ids, done } = brandDir();
  try {
    await decideFact(dir, ids.setup, 'remove');
    let view = await factsView(dir, 'acme');
    assert.equal(view.facts.find((f) => f.factId === ids.setup)?.state, 'removed');
    assert.equal(view.mode, 'all_usable');
    await decideFact(dir, ids.setup, 'restore');
    view = await factsView(dir, 'acme');
    assert.equal(view.facts.find((f) => f.factId === ids.setup)?.state, 'suggested');
  } finally {
    done();
  }
});

test('confirming a fact switches the brand to confirmed facts only, and a held claim can never be confirmed', async () => {
  const { dir, ids, done } = brandDir();
  try {
    await decideFact(dir, ids.setup, 'confirm');
    const view = await factsView(dir, 'acme');
    assert.equal(view.mode, 'approved_only');
    assert.equal(view.facts.find((f) => f.factId === ids.setup)?.state, 'confirmed');
    assert.equal(await refusal(() => decideFact(dir, ids.held, 'confirm')), 'HELD');
    assert.equal(await refusal(() => decideFact(dir, 'nope', 'remove')), 'NOT_FOUND');
    assert.equal(await refusal(() => decideFact(dir, '../x', 'remove')), 'INVALID');
  } finally {
    done();
  }
});

test('a brand with no facts yet says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'facts-view-empty-'));
  try {
    assert.equal(await refusal(() => factsView(dir, 'acme')), 'NOT_FOUND');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
