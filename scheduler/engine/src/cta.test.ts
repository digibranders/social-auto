import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCallToAction, type CtaLink } from './cta.ts';

const ORIGIN = 'https://acme.example';
const link = (text: string, path: string, region: CtaLink['region'] = 'nav'): CtaLink => ({ text, url: `${ORIGIN}${path}`, region });

test('the call to action is an action the site really offers, with the link as evidence', () => {
  const cta = chooseCallToAction([link('Home', '/'), link('Book a visit', '/book'), link('Contact', '/contact')], ORIGIN, 'acme.example');
  assert.equal(cta.kind, 'site-action');
  assert.equal(cta.label, 'Book an appointment');
  assert.equal(cta.evidence?.url, `${ORIGIN}/book`);
  assert.equal(cta.evidence?.linkText, 'Book a visit');
  assert.equal(cta.text, 'Book an appointment at acme.example (link in bio)');
});

test('a site with no booking never gets a booking call to action', () => {
  const cta = chooseCallToAction([link('Shop', '/shop'), link('Journal', '/blog')], ORIGIN, 'acme.example');
  assert.equal(cta.label, 'Browse the shop');
  assert.ok(!/book/i.test(cta.label));
});

test('without any recognisable action it falls back to visiting the real address', () => {
  const cta = chooseCallToAction([link('Our people', '/people')], ORIGIN, 'acme.example');
  assert.equal(cta.kind, 'visit-site');
  assert.equal(cta.label, 'Visit the website');
  assert.equal(cta.evidence, null);
  assert.equal(cta.text, 'Visit acme.example (link in bio)');
});

test('links to other sites are never the destination', () => {
  const cta = chooseCallToAction([{ text: 'Book now', url: 'https://other.example/book', region: 'nav' }], ORIGIN, 'acme.example');
  assert.equal(cta.kind, 'visit-site');
});

test('the action is read from the link text or from the address, in whole words', () => {
  assert.equal(chooseCallToAction([link('Plans', '/p')], ORIGIN, 'a.example').label, 'See pricing');
  assert.equal(chooseCallToAction([link('More', '/pricing')], ORIGIN, 'a.example').label, 'See pricing');
  assert.equal(chooseCallToAction([link('Notebooks', '/notebooks')], ORIGIN, 'a.example').kind, 'visit-site');
});

test('priority follows the rule order, and navigation beats the footer within a rule', () => {
  const cta = chooseCallToAction([link('Contact', '/contact'), link('See pricing', '/pricing', 'footer'), link('Pricing', '/pricing-nav', 'nav')], ORIGIN, 'a.example');
  assert.equal(cta.label, 'See pricing');
  assert.equal(cta.evidence?.url, `${ORIGIN}/pricing-nav`);
});

test('the rules are settings: another language or another action can be supplied', () => {
  const cta = chooseCallToAction([link('Reservar', '/reservar')], ORIGIN, 'a.example', [{ label: 'Reserva ahora', words: ['reservar'] }]);
  assert.equal(cta.label, 'Reserva ahora');
});
