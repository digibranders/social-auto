import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eligibleOptions, type PostFacts } from './art-options.ts';
import { parseArtBrief } from './art-brief.ts';
import { composePoster } from './compose.ts';
import { buildEvidence, type EvidenceFact } from './evidence.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';
import { layoutRegistry } from './layout-registry.ts';
import { iconHtml, offerFrom, offerKind, type PostOffer } from './offer.ts';
import { offerIsStale } from './render.ts';
import { systemFont } from './typography.ts';

const NOW = new Date('2026-11-04T00:00:00Z');
const block = (text: string, over: Partial<PageBlock> = {}): PageBlock => ({ id: 'b', text, tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const factsOf = (blocks: PageBlock[]): EvidenceFact[] => buildEvidence([{ url: 'https://acme.example/pricing', title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks }], NOW).facts;
const find = (facts: EvidenceFact[], needle: string): EvidenceFact => facts.find((f) => f.text.includes(needle)) as EvidenceFact;

test('a usable commercial fact of the post becomes the offer, in its own words, with the icon its kind maps to', () => {
  const facts = factsOf([block('Free plan forever.'), block('No credit card required.'), block('14-day free trial on every paid plan.')]);
  const cases: Array<[string, string, string]> = [['Free plan forever', 'free', 'badge'], ['No credit card', 'no_card', 'card-slash'], ['14-day free trial', 'trial', 'calendar']];
  for (const [needle, kind, icon] of cases) {
    const fact = find(facts, needle);
    const offer = offerFrom([fact.id], facts);
    assert.equal(offer?.text, fact.text, needle);
    assert.equal(offer?.kind, kind);
    assert.equal(offer?.icon, icon);
    assert.equal(offer?.capturedAt, NOW.toISOString());
  }
});

test('a price gets the tag; a fact that states nothing about price, trial, free plan or card gets no icon; a free plan never gets the crossed card', () => {
  const facts = factsOf([block('₹599 /mo', { cardId: 'c1', cardGroup: 'g', cardTitle: 'Starter' }), block('₹1,199 /mo', { cardId: 'c2', cardGroup: 'g', cardTitle: 'Standard' }), block('Free plan available for small teams.'), block('Cancel anytime from your account.')]);
  const price = offerFrom([find(facts, '₹599').id], facts);
  assert.equal(price?.icon, 'tag');
  assert.equal(price?.kicker, 'Starter');
  const free = offerFrom([find(facts, 'Free plan available').id], facts);
  assert.equal(free?.icon, 'badge');
  assert.notEqual(free?.icon, 'card-slash');
  const other = offerFrom([find(facts, 'Cancel anytime').id], facts);
  assert.equal(other?.kind, 'other');
  assert.equal(other?.icon, undefined);
  assert.equal(offerKind({ text: 'Free plan available', values: { numbers: [], prices: [], currencies: [], periods: [], units: [] } }), 'free');
});

test('no offer from a fact held for review, a non-commercial fact, a long fact, a tax note, or facts not assigned to the post', () => {
  const facts = factsOf([
    block('Sample dashboard: free plan with 1,000 credits.'),
    block('Acme answers visitor questions from your own pages and documents.'),
    block('Start a free trial of every paid plan with no credit card and no commitment at all today.'),
    block('Prices exclude GST.'),
    block('14-day free trial on every paid plan.'),
  ]);
  for (const needle of ['Sample dashboard', 'Acme answers', 'Start a free trial', 'Prices exclude GST']) assert.equal(offerFrom([find(facts, needle).id], facts), undefined, needle);
  assert.equal(offerFrom(undefined, facts), undefined);
  assert.equal(offerFrom([], facts), undefined);
  assert.equal(offerFrom(['unknown-id'], facts), undefined);
  assert.equal(offerFrom([find(facts, 'Acme answers').id], facts), undefined);
});

test('a tax note is shown under the offer only when the page tied it to the same plan', () => {
  const facts = factsOf([
    block('₹599 /mo', { cardId: 'c1', cardGroup: 'g', cardTitle: 'Starter' }), block('Plus 18% GST at checkout.', { cardId: 'c1', cardGroup: 'g', cardTitle: 'Starter' }),
    block('₹1,199 /mo', { cardId: 'c2', cardGroup: 'g', cardTitle: 'Standard' }),
    block('Prices exclude GST.'),
  ]);
  assert.equal(offerFrom([find(facts, '₹599').id], facts)?.qualifier, 'Plus 18% GST at checkout.');
  assert.equal(offerFrom([find(facts, '₹1,199').id], facts)?.qualifier, undefined);
});

test('an offer read too long ago is stale and is not shown', () => {
  assert.equal(offerIsStale({ capturedAt: '2026-11-01T00:00:00Z' }, NOW), false);
  assert.equal(offerIsStale({ capturedAt: '2026-09-01T00:00:00Z' }, NOW), true);
  assert.equal(offerIsStale({ capturedAt: 'not a date' }, NOW), true);
});

const OFFER: PostOffer = { factId: 'f1', text: 'Free plan forever', kicker: 'Starter', qualifier: 'Plus 18% GST at checkout.', kind: 'free', icon: 'badge', capturedAt: NOW.toISOString() };
const facts = (over: Partial<PostFacts> = {}): PostFacts => ({ headline: 'Start with a |free plan|', subline: 'Acme keeps it simple', listItems: [], concernsOffering: false, ...over });

test('an offer makes the evidence layout available, with no picture needed; no offer, figure or quote keeps it out', () => {
  const withOffer = eligibleOptions(facts({ offer: OFFER }), layoutRegistry, {});
  const spotlight = withOffer.options.filter((o) => o.layout === 'evidence-spotlight');
  assert.ok(spotlight.length > 0);
  assert.ok(spotlight.some((o) => o.hierarchy === 'figure-first' && o.pictureRole === 'none'));
  const without = eligibleOptions(facts(), layoutRegistry, {});
  assert.ok(!without.options.some((o) => o.layout === 'evidence-spotlight'));
  assert.ok(without.ineligible.some((i) => i.layout === 'evidence-spotlight' && /figure, quotation or offer/.test(i.reason)));
});

const brand = { name: 'Acme', colors: { ink: '#14213D', accent: '#FCA311', background: '#FFFFFF', tile: '#F2F2F2' }, identityLine: 'Project tracking', cta: { label: 'Visit', host: 'acme.example' } };
const spotlightBrief = (hierarchy = 'figure-first') => parseArtBrief({ layout: 'evidence-spotlight', hierarchy, headlineScale: 'large', alignment: 'start', textZone: 'center', picture: { role: 'none' }, logoSlot: 'top-left', identitySlot: 'under-logo', ctaSlot: 'top-right' }, 'p');

test('the offer poster shows the fact in its own words with plan, icon and condition in one measured block, and needs no picture', () => {
  const { html } = composePoster({ brief: spotlightBrief(), copy: { headline: 'Start with a |free plan|', subline: 'Acme keeps it simple', offer: OFFER }, brand, font: systemFont('Inter'), mode: { kind: 'measure' } });
  assert.match(html, /data-slot="figure"/);
  assert.match(html, /data-role="offer"/);
  assert.match(html, /Free plan forever/);
  assert.match(html, />Starter</);
  assert.match(html, /Plus 18% GST at checkout\./);
  assert.match(html, /<svg viewBox="0 0 24 24"/);
  assert.ok(!html.includes('data-slot="picture"'));
  assert.ok(!html.includes('<img'));
});

test('an offer with no icon draws none, offer text is escaped, and a figure-first poster with no figure, quote or offer is refused', () => {
  const { html } = composePoster({ brief: spotlightBrief(), copy: { headline: 'h', subline: 's', offer: { ...OFFER, text: '<b>x</b> free', icon: undefined, kicker: undefined, qualifier: undefined } as PostOffer }, brand, font: systemFont('Inter'), mode: { kind: 'measure' } });
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; free/);
  assert.ok(!html.slice(html.indexOf('data-slot="figure"')).includes('<svg viewBox="0 0 24 24"'));
  assert.throws(() => composePoster({ brief: spotlightBrief(), copy: { headline: 'h', subline: 's' }, brand, font: systemFont('Inter'), mode: { kind: 'measure' } }), /figure, quotation or offer/);
  assert.match(iconHtml('card-slash'), /aria-hidden="true"/);
});


test('a price with no billing period is not shown on its own as an offer; the same price with its period is', () => {
  const noPeriod = factsOf([block('Only ₹599 for the first plan.', { cardId: 'c1', cardGroup: 'g', cardTitle: 'Starter' }), block('Only ₹999 for the next plan.', { cardId: 'c2', cardGroup: 'g', cardTitle: 'Pro' })]);
  assert.equal(offerFrom([find(noPeriod, '₹599').id], noPeriod), undefined);
  const withPeriod = factsOf([block('₹599 /mo', { cardId: 'c1', cardGroup: 'g', cardTitle: 'Starter' }), block('₹999 /mo', { cardId: 'c2', cardGroup: 'g', cardTitle: 'Pro' })]);
  assert.equal(offerFrom([find(withPeriod, '₹599').id], withPeriod)?.kind, 'price');
});


import { postFacts } from './art-options.ts';
import type { Brand, PlannedPost } from './content.ts';

test('an offer is not used when the headline already says the same thing, so the poster never prints one sentence twice', () => {
  const facts = factsOf([block('14-day free trial on every plan.')]);
  const trial = find(facts, '14-day');
  const brand = { offer: '', features: [], proofPoints: [] } as unknown as Pick<Brand, 'offer' | 'features' | 'proofPoints'>;
  const post = (headline: string): PlannedPost => ({ id: 'p', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: 'template', headline, subline: 'Acme', caption: 'c', hashtags: [], factIds: [trial.id] }) as unknown as PlannedPost;
  assert.equal(postFacts(post('A free trial on |every plan|'), brand, facts).offer, undefined);
  assert.equal(postFacts(post('Start before you decide'), brand, facts).offer?.text, trial.text);
});
