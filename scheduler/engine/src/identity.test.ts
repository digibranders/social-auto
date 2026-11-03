import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageSource } from './claims.ts';
import { chooseIdentity, identityKindFor, metadataSource, type IdentityCandidate } from './identity.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const RECENT = '2026-11-01T00:00:00Z';
const ORIGIN = 'https://acme.example';
const pages: PageSource[] = [
  { url: `${ORIGIN}/`, fetchedAt: RECENT, text: 'Accounting software for small businesses. Send invoices and track what you are owed.' },
  { url: `${ORIGIN}/about`, fetchedAt: RECENT, text: 'We are a team that builds bookkeeping tools for independent shops and studios.' },
  { url: `${ORIGIN}/services`, fetchedAt: RECENT, text: 'Our invoicing tool sends reminders to customers who pay late.' },
];
const metadata: PageSource[] = [metadataSource(ORIGIN, { title: 'Acme Books', description: 'Simple bookkeeping for freelancers.' }, RECENT)];
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
    { line: 'Simple bookkeeping for freelancers', sourceUrl: `metadata:${ORIGIN}`, quote: 'Simple bookkeeping for freelancers.' },
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
  assert.equal(identityKindFor(`metadata:${ORIGIN}`, ORIGIN), 'metadata');
  assert.equal(identityKindFor(`${ORIGIN}/nosotros`, ORIGIN, { aboutWords: ['nosotros'] }), 'about');
});
