import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CREATIVE_MOVES, eligibleMoves, isMoveId, moveBrief } from './creative-moves.ts';
import { buildEvidence, type EvidenceFact } from './evidence.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';

const block = (over: Partial<PageBlock>): PageBlock => ({ id: 'b', text: '', tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const structure = (url: string, blocks: Array<Partial<PageBlock>>): PageStructure => ({ url, title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: blocks.map((b, i) => block({ id: `b${i}`, ...b })) });
const fact = (text: string, over: Partial<EvidenceFact> = {}): EvidenceFact => ({ ...(buildEvidence([structure('https://x.example/features', [{ text }])], new Date('2026-11-04T00:00:00Z')).facts[0] as EvidenceFact), ...over });

test('a figure or an offer is shown as the evidence itself', () => {
  const trial = fact('14-day free trial on every paid plan.', { category: 'commercial_term' });
  assert.equal(eligibleMoves([trial])[0], 'evidence_hero');
  assert.ok(!eligibleMoves([trial]).includes('direct_demonstration'));
});

test('a capability may be demonstrated; one that states a flow may also be shown as input to output', () => {
  const plain = fact('Replies come from your own documents.', { category: 'capability' });
  const flow = fact('The chat moves to an operator in the same thread.', { category: 'capability' });
  assert.ok(eligibleMoves([plain]).includes('direct_demonstration'));
  assert.ok(!eligibleMoves([plain]).includes('input_output'));
  assert.ok(eligibleMoves([flow]).includes('input_output'));
});

test('a mapped metaphor is offered last and never for a figure or an offer on its own', () => {
  const capability = fact('Searches by meaning.', { category: 'capability' });
  const moves = eligibleMoves([capability]);
  assert.equal(moves.at(-1), 'mapped_metaphor');
  const offer = fact('Free plan with no card needed.', { category: 'offer' });
  assert.ok(!eligibleMoves([offer]).includes('mapped_metaphor'));
});

test('at most three moves are offered, and none when there is no fact', () => {
  const rich = fact('Turns 5 documents into answers.', { category: 'capability' });
  assert.ok(eligibleMoves([rich]).length <= 3);
  assert.deepEqual(eligibleMoves([]), []);
});

test('the registry defines each move once and the brief carries what must be shown and what must not be implied', () => {
  for (const id of Object.keys(CREATIVE_MOVES)) assert.ok(isMoveId(id));
  assert.ok(!isMoveId('copy_a_campaign'));
  const brief = moveBrief(['evidence_hero', 'direct_demonstration']);
  assert.match(brief, /evidence_hero: .*must show .*must not imply/);
  assert.match(brief, /direct_demonstration:/);
  for (const move of Object.values(CREATIVE_MOVES)) assert.doesNotMatch(`${move.principle} ${move.mustShow} ${move.avoid}`, /FedEx|Heinz|LEGO|IKEA|Volkswagen|Spotify|campaign/i, 'no named campaign or brand in a move');
});
