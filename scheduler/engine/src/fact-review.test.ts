import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildEvidence, type EvidenceFact } from './evidence.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';
import { applyReview, decide, emptyReview, loadReview, REVIEW_FILE, saveReview, shortlist } from './fact-review.ts';

const NOW = new Date('2026-11-04T00:00:00Z');
const block = (text: string, over: Partial<PageBlock> = {}): PageBlock => ({ id: 'b', text, tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const facts = (): EvidenceFact[] => buildEvidence([{ url: 'https://acme.example/features', title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: [
  block('Acme Replies answers visitor questions from your own pages and documents.'),
  block('Installation takes under 10 minutes and uses one script tag.'),
  block('When a visitor asks for a human, the chat moves to an operator in the same thread.'),
  block('Our uptime target is 99.9% every month.'),
] }], NOW).facts;

test('the shortlist holds only offerable facts, best first, up to the limit', () => {
  const all = facts();
  const list = shortlist(all, [], 2);
  assert.equal(list.length, 2);
  assert.ok(list.every((f) => f.status === 'usable' && !f.text.includes('uptime target')));
  assert.equal(shortlist(all, [], 25).length, 3);
});

test('with nothing approved every usable fact is eligible; once something is approved only approved facts are', () => {
  const all = facts().filter((f) => f.status === 'usable');
  assert.deepEqual(applyReview(all, null), { facts: all, mode: 'all_usable', approved: 0, rejected: 0 });
  const [a, b] = all as [EvidenceFact, EvidenceFact];
  const approved = applyReview(all, decide(emptyReview(), all, [a.id], 'approved', NOW));
  assert.equal(approved.mode, 'approved_only');
  assert.deepEqual(approved.facts.map((f) => f.id), [a.id]);
  const rejectedOnly = applyReview(all, decide(emptyReview(), all, [b.id], 'rejected', NOW));
  assert.equal(rejectedOnly.mode, 'all_usable');
  assert.ok(!rejectedOnly.facts.some((f) => f.id === b.id));
  const both = applyReview(all, decide(decide(emptyReview(), all, [a.id, b.id], 'approved', NOW), all, [b.id], 'rejected', NOW));
  assert.deepEqual(both.facts.map((f) => f.id), [a.id]);
});

test('an approved fact that changed on the site, or is now held, is no longer used', () => {
  const all = facts().filter((f) => f.status === 'usable');
  const review = decide(emptyReview(), all, [(all[0] as EvidenceFact).id], 'approved', NOW);
  const changed = buildEvidence([{ url: 'https://acme.example/features', title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: [block('Acme Replies now answers every question instantly from your documents.')] }], NOW).facts;
  assert.equal(applyReview(changed, review).facts.length, 0);
  // A fact that is now held is not among the usable facts handed to the review, so its approval does nothing.
  assert.equal(applyReview([], review).facts.length, 0);
});

test('decisions are recorded by id or unique prefix; unknown or ambiguous names record nothing', () => {
  const all = facts();
  const first = all[0] as EvidenceFact;
  const byPrefix = decide(emptyReview(), all, [first.id.slice(0, 6)], 'approved', NOW);
  assert.equal(byPrefix.decisions[first.id]?.decision, 'approved');
  assert.throws(() => decide(emptyReview(), all, ['zzzzzz'], 'approved', NOW), /no fact has the id/);
  const twins = [{ ...first, id: 'abcd1111' }, { ...first, id: 'abcd2222' }];
  assert.throws(() => decide(emptyReview(), twins, ['abcd'], 'approved', NOW), /matches 2 facts/);
  assert.equal(decide(emptyReview(), twins, ['abcd1111'], 'approved', NOW).decisions['abcd1111']?.decision, 'approved');
  assert.throws(() => decide(emptyReview(), all, ['ab'], 'approved', NOW), /no fact has the id/);
});

test('reviews are saved per brand folder, read back, and a damaged file is an error; two brands never share decisions', async () => {
  const a = await mkdtemp(join(tmpdir(), 'review-a-'));
  const b = await mkdtemp(join(tmpdir(), 'review-b-'));
  try {
    assert.equal(await loadReview(a), null);
    const all = facts();
    await saveReview(a, decide(emptyReview(), all, [(all[0] as EvidenceFact).id], 'approved', NOW));
    assert.equal(Object.keys((await loadReview(a))?.decisions ?? {}).length, 1);
    assert.equal(await loadReview(b), null);
    await writeFile(join(a, REVIEW_FILE), '{nope');
    await assert.rejects(loadReview(a), /not valid JSON/);
    await writeFile(join(a, REVIEW_FILE), JSON.stringify({ version: 1, decisions: { x: { decision: 'maybe', text: 't' } } }));
    await assert.rejects(loadReview(a), /malformed decision/);
    await writeFile(join(a, REVIEW_FILE), JSON.stringify({ version: 2, decisions: {} }));
    await assert.rejects(loadReview(a), /wrong shape/);
    assert.match(await readFile(join(a, REVIEW_FILE), 'utf8'), /version/);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});
