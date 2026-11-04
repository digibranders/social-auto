import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEditorial, type EditorialContext } from './editorial.ts';

const ctx = (over: Partial<EditorialContext> = {}): EditorialContext => ({ brandName: 'Acme Replies', identityLine: 'A support chatbot for small websites', ...over });
const codes = (r: ReturnType<typeof validateEditorial>): { hard: string[]; warnings: string[] } => ({ hard: r.hard.map((i) => i.code), warnings: r.warnings.map((i) => i.code) });

test('a subline that is the headline said again is a hard failure, whatever the case, pipes or brand name', () => {
  assert.deepEqual(codes(validateEditorial({ headline: 'Start with a |free plan|', subline: 'start with a free plan.' }, ctx())).hard, ['subline_restates_headline']);
  assert.deepEqual(codes(validateEditorial({ headline: 'Answers from your |own pages|', subline: 'Acme Replies: answers from your own pages' }, ctx())).hard, ['subline_restates_headline']);
});

test('a subline that repeats the identity line is a hard failure', () => {
  const r = validateEditorial({ headline: 'Visitors leave without |answers|', subline: 'Acme Replies, a support chatbot for small websites.' }, ctx());
  assert.deepEqual(codes(r).hard, ['subline_restates_identity']);
});

test('near-identical wording that adds nothing supported is a hard failure', () => {
  const r = validateEditorial({ headline: 'Setup takes |minutes| with one script tag', subline: 'One script tag, setup takes minutes.' }, ctx());
  assert.deepEqual(codes(r).hard, ['subline_adds_nothing']);
});

test('similar vocabulary is allowed when the subline adds a new figure or a fact the post is built on', () => {
  const withFigure = validateEditorial({ headline: 'Start with a |free plan|', subline: 'Free plan. 100 credits every month.' }, ctx());
  assert.deepEqual(codes(withFigure), { hard: [], warnings: [] });
  const cited = [{ text: 'No credit card required.', category: 'commercial_term' as const }];
  const withFact = validateEditorial({ headline: 'Start with a |free plan|', subline: 'Free plan. No credit card required.' }, ctx({ citedFacts: cited }));
  assert.deepEqual(codes(withFact), { hard: [], warnings: [] });
});

test('overlapping wording whose extra words no cited fact backs is a warning, not a failure', () => {
  const r = validateEditorial({ headline: 'Answers from your |own pages|', subline: 'Grounded answers from your own pages, always.' }, ctx());
  assert.deepEqual(codes(r).hard, []);
  assert.deepEqual(codes(r).warnings, ['subline_overlap_unsupported_extra']);
});

test('a subline on a different point passes with no issue', () => {
  const r = validateEditorial({ headline: 'Visitors leave without |answers|', subline: 'Acme Replies answers from your own pages.' }, ctx());
  assert.deepEqual(codes(r), { hard: [], warnings: [] });
});

test('the brand name repeated across headline, subline and identity line is a warning', () => {
  const r = validateEditorial({ headline: 'Why Acme Replies is |different|', subline: 'Acme Replies helps Acme Replies visitors.' }, ctx({ identityLine: 'Acme Replies, a support chatbot' }));
  assert.ok(codes(r).warnings.includes('brand_name_repeated'));
  assert.deepEqual(codes(r).hard, []);
});

test('a pricing call to action on a post built on non-commercial facts is a warning; on a commercial fact it is not', () => {
  const copy = { headline: 'Visitors leave without |answers|', subline: 'Acme Replies answers from your own pages.' };
  const process = [{ text: 'Installation takes under 10 minutes.', category: 'process' as const }];
  assert.deepEqual(codes(validateEditorial(copy, ctx({ cta: 'See pricing at acme.example', citedFacts: process }))).warnings, ['cta_mismatch']);
  assert.deepEqual(codes(validateEditorial(copy, ctx({ cta: 'See pricing at acme.example', citedFacts: [{ text: '₹599 /mo', category: 'commercial_term' }] }))).warnings, []);
  assert.deepEqual(codes(validateEditorial(copy, ctx({ cta: 'Try it at acme.example', citedFacts: process }))).warnings, []);
  assert.deepEqual(codes(validateEditorial(copy, ctx({ cta: 'See pricing at acme.example' }))).warnings, []);
});

test('headline strength is never scored: a weak but distinct pair passes', () => {
  const r = validateEditorial({ headline: 'Things happen', subline: 'Acme Replies answers visitors from your pages.' }, ctx());
  assert.deepEqual(codes(r), { hard: [], warnings: [] });
});

test('empty or brand-only sublines do not crash the check', () => {
  assert.doesNotThrow(() => validateEditorial({ headline: '|x|', subline: '' }, ctx()));
  assert.doesNotThrow(() => validateEditorial({ headline: 'Acme Replies', subline: 'Acme Replies' }, ctx({ identityLine: undefined } as Partial<EditorialContext>)));
});
