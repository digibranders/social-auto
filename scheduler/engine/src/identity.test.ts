import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageSource } from './claims.ts';
import { chooseIdentity, classifyIdentity, identityKindFor, metadataSources, type IdentityCandidate } from './identity.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const RECENT = '2026-11-01T00:00:00Z';
const ORIGIN = 'https://acme.example';
const pages: PageSource[] = [
  { url: `${ORIGIN}/`, fetchedAt: RECENT, text: 'Accounting software for small businesses. Send invoices and track what you are owed.' },
  { url: `${ORIGIN}/about`, fetchedAt: RECENT, text: 'We are a team that builds bookkeeping tools for independent shops and studios.' },
  { url: `${ORIGIN}/services`, fetchedAt: RECENT, text: 'Our invoicing tool sends reminders to customers who pay late.' },
];
const metadata: PageSource[] = metadataSources([{ url: `${ORIGIN}/`, title: 'Acme Books', description: 'Simple bookkeeping for freelancers.', fetchedAt: RECENT }]);
const pick = (candidates: IdentityCandidate[], extra: Partial<Parameters<typeof chooseIdentity>[0]> = {}) =>
  chooseIdentity({ name: 'Acme', origin: ORIGIN, candidates, pages, metadata, now: NOW, ...extra });

test('a line the homepage states is verified and recorded with its source', () => {
  const identity = pick([{ line: 'Accounting software for small businesses', sourceUrl: `${ORIGIN}/`, quote: 'Accounting software for small businesses.' }]);
  assert.equal(identity.kind, 'homepage');
  assert.equal(identity.line, 'Accounting software for small businesses');
  assert.equal(identity.verification.status, 'verified');
  assert.equal(identity.source?.url, `${ORIGIN}/`);
  assert.match(identity.source?.contentHash ?? '', /^sha256:/);
});

test('the ladder: homepage beats about beats offering beats metadata, whatever order the model gave them', () => {
  const candidates: IdentityCandidate[] = [
    { line: 'Simple bookkeeping for freelancers', sourceUrl: `metadata:description:${ORIGIN}/`, quote: 'Simple bookkeeping for freelancers.' },
    { line: 'An invoicing tool that sends reminders', sourceUrl: `${ORIGIN}/services`, quote: 'Our invoicing tool sends reminders to customers who pay late.' },
    { line: 'Bookkeeping tools for independent shops and studios', sourceUrl: `${ORIGIN}/about`, quote: 'builds bookkeeping tools for independent shops and studios' },
  ];
  assert.equal(pick(candidates).kind, 'about');
  assert.equal(pick(candidates.slice(0, 2)).kind, 'offering');
  assert.equal(pick(candidates.slice(0, 1)).kind, 'metadata');
});

test('a candidate whose quote is not on the page is skipped, and the next verified one is used', () => {
  const identity = pick([
    { line: 'The best accounting platform on earth', sourceUrl: `${ORIGIN}/`, quote: 'The best accounting platform on earth' },
    { line: 'Bookkeeping tools for independent shops and studios', sourceUrl: `${ORIGIN}/about`, quote: 'builds bookkeeping tools for independent shops and studios' },
  ]);
  assert.equal(identity.kind, 'about');
});

test('a line that claims more than its quote is not verified', () => {
  const identity = pick([{ line: 'Accounting software trusted by 10,000 small businesses', sourceUrl: `${ORIGIN}/`, quote: 'Accounting software for small businesses.' }]);
  assert.equal(identity.kind, 'name-only');
});

test('with nothing verified the identity is the brand name alone: no invented category', () => {
  const identity = pick([]);
  assert.equal(identity.kind, 'name-only');
  assert.equal(identity.line, 'Acme');
  assert.equal(identity.source, null);
  assert.match(identity.verification.reasons.join(' '), /no verified/i);
});

test('an approved line wins over everything and records that it was approved, not read', () => {
  const identity = pick([{ line: 'Accounting software for small businesses', sourceUrl: `${ORIGIN}/`, quote: 'Accounting software for small businesses.' }], { approved: 'Bookkeeping that keeps freelancers paid' });
  assert.equal(identity.kind, 'approved');
  assert.equal(identity.line, 'Bookkeeping that keeps freelancers paid');
  assert.equal(identity.source, null);
});

test('a line must be one short plain sentence', () => {
  const long = 'x'.repeat(95);
  assert.equal(pick([{ line: long, sourceUrl: `${ORIGIN}/`, quote: 'Accounting software for small businesses.' }]).kind, 'name-only');
  assert.equal(pick([{ line: 'Accounting software. For small businesses.', sourceUrl: `${ORIGIN}/`, quote: 'Accounting software for small businesses.' }]).kind, 'name-only');
});

test('a thin one-page site with no About still gets an identity from its homepage', () => {
  const onePage: PageSource[] = [{ url: `${ORIGIN}/`, fetchedAt: RECENT, text: 'Fresh bread baked every morning. Order online or visit the shop.' }];
  const identity = chooseIdentity({ name: 'Acme', origin: ORIGIN, pages: onePage, metadata: [], now: NOW, candidates: [{ line: 'Fresh bread baked every morning', sourceUrl: `${ORIGIN}/`, quote: 'Fresh bread baked every morning.' }] });
  assert.equal(identity.kind, 'homepage');
});

test('the kind comes from the page address, with words that are settings', () => {
  assert.equal(identityKindFor(`${ORIGIN}/`, ORIGIN), 'homepage');
  assert.equal(identityKindFor(`${ORIGIN}/about-us`, ORIGIN), 'about');
  assert.equal(identityKindFor(`${ORIGIN}/our-story`, ORIGIN), 'about');
  assert.equal(identityKindFor(`${ORIGIN}/pricing`, ORIGIN), 'offering');
  assert.equal(identityKindFor(`metadata:description:${ORIGIN}/`, ORIGIN), 'metadata');
  assert.equal(identityKindFor(`${ORIGIN}/nosotros`, ORIGIN, { aboutWords: ['nosotros'] }), 'about');
});

test('a slogan is not an identity: imperatives, short mottos and vague aspirations are turned back', () => {
  assert.equal(classifyIdentity('Think different'), 'slogan');
  assert.equal(classifyIdentity('Discover the difference'), 'slogan');
  assert.equal(classifyIdentity('Join us today'), 'slogan');
  assert.equal(classifyIdentity('Accounting software for small businesses'), 'descriptive');
  assert.equal(classifyIdentity('We develop websites for growing businesses'), 'descriptive');
  assert.equal(classifyIdentity('Project management software for construction teams'), 'descriptive');
  assert.equal(classifyIdentity('Fresh bread baked every morning'), 'uncertain');
  assert.equal(classifyIdentity('Quality and care in everything we do'), 'uncertain');
});

test('a slogan that is on the page is still refused, and a description is chosen whatever the order', () => {
  const sloganPages: PageSource[] = [{ url: `${ORIGIN}/`, fetchedAt: RECENT, text: 'Think different. Accounting software for small businesses.' }];
  const base = { name: 'Acme', origin: ORIGIN, pages: sloganPages, metadata: [], now: NOW };
  const slogan: IdentityCandidate = { line: 'Think different', sourceUrl: `${ORIGIN}/`, quote: 'Think different.' };
  const real: IdentityCandidate = { line: 'Accounting software for small businesses', sourceUrl: `${ORIGIN}/`, quote: 'Accounting software for small businesses.' };
  assert.equal(chooseIdentity({ ...base, candidates: [slogan] }).kind, 'name-only');
  for (const candidates of [[slogan, real], [real, slogan]]) assert.equal(chooseIdentity({ ...base, candidates }).line, real.line);
  assert.equal(chooseIdentity({ ...base, candidates: [real] }).type, 'descriptive');
});

test('content outranks location: a precise offering page beats a vague about page', () => {
  const identity = pick([
    { line: 'Quality and care in everything we do', sourceUrl: `${ORIGIN}/about`, quote: 'Quality and care in everything we do' },
    { line: 'An invoicing tool that sends reminders', sourceUrl: `${ORIGIN}/services`, quote: 'Our invoicing tool sends reminders to customers who pay late.' },
  ], { pages: [...pages.slice(0, 1), { url: `${ORIGIN}/about`, fetchedAt: RECENT, text: 'Quality and care in everything we do.' }, pages[2] as PageSource] });
  assert.equal(identity.kind, 'offering');
  assert.equal(identity.type, 'descriptive');
});

test('locale roots count as the homepage, and a section is not mistaken for one', () => {
  assert.equal(identityKindFor(`${ORIGIN}/en/`, ORIGIN), 'homepage');
  assert.equal(identityKindFor(`${ORIGIN}/hi`, ORIGIN), 'homepage');
  assert.equal(identityKindFor(`${ORIGIN}/en-gb/`, ORIGIN), 'homepage');
  assert.equal(identityKindFor(`${ORIGIN}/en/about`, ORIGIN), 'about');
  assert.equal(identityKindFor(`${ORIGIN}/faq`, ORIGIN), 'offering');
});

test('title and description are separate sources, so a quote cannot span text that was never together', () => {
  const sources = metadataSources([{ url: `${ORIGIN}/`, title: 'Acme Books', description: 'Simple bookkeeping for freelancers.' }]);
  assert.deepEqual(sources.map((m) => m.url), [`metadata:title:${ORIGIN}/`, `metadata:description:${ORIGIN}/`]);
  const spanning = pick([{ line: 'Acme Books for simple bookkeeping', sourceUrl: `metadata:description:${ORIGIN}/`, quote: 'Acme Books. Simple bookkeeping' }], { pages: [], metadata: sources });
  assert.equal(spanning.kind, 'name-only');
  const alone = pick([{ line: 'Simple bookkeeping for freelancers', sourceUrl: `metadata:description:${ORIGIN}/`, quote: 'Simple bookkeeping for freelancers.' }], { pages: [], metadata: sources });
  assert.equal(alone.kind, 'metadata');
});
