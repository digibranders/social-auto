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

test('the poster that exposed the gap: "Keep the deal conversation in one thread" against "OyeChats keeps the whole conversation in one thread" is redundant', () => {
  const r = validateEditorial({ headline: 'Keep the deal conversation in |one thread|', subline: 'OyeChats keeps the whole conversation in one thread.' }, ctx({ brandName: 'OyeChats', identityLine: undefined } as Partial<EditorialContext>));
  assert.deepEqual(codes(r).hard, ['subline_adds_nothing']);
});

test('sublines on a different point or with a new condition are not touched by the stricter overlap rule', () => {
  const allowed: Array<[string, string]> = [
    ['Start with a |free plan|', 'Free plan. No credit card required.'],
    ['Track visitor |intent|', 'Intent scores update during conversations.'],
    ['Start your |14-day trial|', 'No credit card required.'],
  ];
  for (const [headline, subline] of allowed) assert.deepEqual(codes(validateEditorial({ headline, subline }, ctx())).hard, [], subline);
});

test('a caption that says the same thing twice gets a warning, a caption of distinct sentences does not', () => {
  const copy = { headline: 'Visitors leave without |answers|', subline: 'Acme Replies answers from your own pages.' };
  const padded = 'Acme Replies scores intent while visitors chat. Visitors chat and Acme Replies scores their intent while they chat. Then buyers reach your team.';
  assert.ok(codes(validateEditorial({ ...copy, caption: padded }, ctx())).warnings.includes('caption_repeats_itself'));
  const distinct = 'Acme Replies scores intent while visitors chat. Hot buyers are routed to your team with the transcript. Setup is one script tag.';
  assert.ok(!codes(validateEditorial({ ...copy, caption: distinct }, ctx())).warnings.includes('caption_repeats_itself'));
});


test('the image poster that slipped through: "Your docs ground every answer" against "OyeChats grounds every answer in your own docs" is redundant even though the cited fact contains "own"', () => {
  const cited = [{ text: 'Every answer is grounded in your own docs, retrieved via hybrid semantic and keyword search.', category: 'capability' as const }];
  const r = validateEditorial({ headline: 'Your docs ground |every answer|', subline: 'OyeChats grounds every answer in your own docs.' }, ctx({ brandName: 'OyeChats', identityLine: undefined, citedFacts: cited } as Partial<EditorialContext>));
  assert.deepEqual(codes(r).hard, ['subline_adds_nothing']);
});

test('a headline built from semicolon or slash fragments gets an advisory warning, never a hard failure', () => {
  const copy = (headline: string) => ({ headline, subline: 'Acme answers from your own pages.' });
  assert.deepEqual(codes(validateEditorial(copy('Add/remove documents; |automatic re-indexing|'), ctx())).warnings.includes('headline_reads_like_feature_label'), true);
  assert.deepEqual(codes(validateEditorial(copy('Add/remove documents; |automatic re-indexing|'), ctx())).hard, []);
  assert.ok(!codes(validateEditorial(copy('Documents update |automatically|'), ctx())).warnings.includes('headline_reads_like_feature_label'));
  assert.ok(!codes(validateEditorial(copy('Support that never |sleeps|'), ctx())).warnings.includes('headline_reads_like_feature_label'));
});
