import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligibleOptions, postFacts, type PostFacts } from './art-options.ts';
import type { Brand, PlannedPost } from './content.ts';
import { layoutRegistry, SAFE_FAMILY } from './layout-registry.ts';
import { pictureEligibility } from './visual-strategy.ts';

const concept = (over: Partial<{ subject: string; angle: string; message: string; visualSubject: string; visualAction: string }> = {}) => ({
  subject: 'buyer routing', angle: 'what happens at the moment of intent', message: 'intent is scored and the buyer reaches your team', visualSubject: 'a glowing speech bubble', visualAction: 'handing a key to a second bubble', ...over,
});
const copy = { headline: 'What happens when a visitor |wants to buy|?', subline: 'Acme scores intent in chat and routes buyers to your team.' };

test('a concrete subject that the post itself mentions may have a picture', () => {
  assert.deepEqual(pictureEligibility({ ...copy, concept: concept({ visualSubject: 'a speech bubble scoring a visitor', visualAction: 'routing a buyer' }) }), { eligible: true, reasons: [] });
  assert.equal(pictureEligibility({ ...copy, caption: 'Scores intent while visitors chat.', concept: concept({ visualSubject: 'a chat window', visualAction: 'opening' }) }).eligible, true);
});

test('a subject that nothing in the post mentions gets no picture: a clock for a post about routing buyers', () => {
  const gate = pictureEligibility({ ...copy, concept: concept({ visualSubject: 'a glossy clock face', visualAction: 'ticking quietly' }), caption: 'It scores intent as they chat.' });
  assert.equal(gate.eligible, false);
  assert.match(gate.reasons.join(' '), /nothing in the picture/);
});

test('a missing concept, an empty subject or action, or a vague subject gets no picture', () => {
  assert.equal(pictureEligibility(copy).eligible, false);
  assert.match(pictureEligibility(copy).reasons.join(' '), /no accepted concept/);
  assert.match(pictureEligibility({ ...copy, concept: concept({ visualSubject: ' ' }) }).reasons.join(' '), /no picture subject/);
  assert.match(pictureEligibility({ ...copy, concept: concept({ visualAction: '' }) }).reasons.join(' '), /no picture subject and action/);
  assert.match(pictureEligibility({ ...copy, concept: concept({ visualSubject: 'an abstract idea' }) }).reasons.join(' '), /nothing concrete|nothing in the picture/);
});

test('the same post and concept always give the same answer', () => {
  const post = { ...copy, concept: concept() };
  assert.deepEqual(pictureEligibility(post), pictureEligibility(post));
});

const facts = (picture?: PostFacts['picture']): PostFacts => ({ headline: 'Keep every |project| visible', subline: 'Acme shows where work stands', listItems: [], concernsOffering: false, ...(picture ? { picture } : {}) });
const roles = (f: PostFacts, settings = {}): string[] => [...new Set(eligibleOptions(f, layoutRegistry, settings).options.map((o) => o.pictureRole))];

test('options for a post with no eligible picture all use no picture, and layouts that need one say why they are out', () => {
  const blocked = facts({ eligible: false, reasons: ['nothing in the picture ("a clock") is mentioned in what the post says'] });
  const { options, ineligible } = eligibleOptions(blocked, layoutRegistry, {});
  assert.deepEqual(roles(blocked), ['none']);
  assert.ok(options.length > 0);
  assert.ok(options.some((o) => o.layout === SAFE_FAMILY));
  assert.ok(ineligible.some((i) => /no picture is allowed/.test(i.reason)));
  assert.ok(options.every((o) => o.hierarchy !== 'picture-first' && o.mediums.length === 0));
});

test('with an eligible picture, with no verdict, or with the gate switched off, picture options remain', () => {
  assert.ok(roles(facts({ eligible: true, reasons: [] })).some((r) => r !== 'none'));
  assert.ok(roles(facts()).some((r) => r !== 'none'));
  assert.ok(roles(facts({ eligible: false, reasons: ['x'] }), { pictureGate: false }).some((r) => r !== 'none'));
});

test('postFacts records the gate result from the post\'s copy and concept', () => {
  const brand = { offer: 'Chat', features: [], proofPoints: [] } as unknown as Pick<Brand, 'offer' | 'features' | 'proofPoints'>;
  const post = { id: 'p', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: 'template', headline: copy.headline, subline: copy.subline, caption: 'Scores intent while visitors chat.', hashtags: [], concept: concept({ visualSubject: 'a clock', visualAction: 'ticking' }) } as unknown as PlannedPost;
  assert.equal(postFacts(post, brand).picture?.eligible, false);
  assert.equal(postFacts({ ...post, concept: concept({ visualSubject: 'a speech bubble for a buyer', visualAction: 'routing' }) } as PlannedPost, brand).picture?.eligible, true);
});
