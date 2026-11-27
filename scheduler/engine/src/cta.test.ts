import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCallToAction, defaultCtaRules, type CtaLink } from './cta.ts';

const ORIGIN = 'https://acme.example';
const link = (text: string, path: string, region: CtaLink['region'] = 'nav'): CtaLink => ({ text, url: `${ORIGIN}${path}`, region });

test('the call to action is an action the site really offers, with the link as evidence', () => {
  const cta = chooseCallToAction([link('Home', '/'), link('Book a visit', '/book'), link('Contact', '/contact')], ORIGIN, 'acme.example');
  assert.equal(cta.kind, 'site-action');
  assert.equal(cta.label, 'Book an appointment');
  assert.equal(cta.evidence?.url, `${ORIGIN}/book`);
  assert.equal(cta.evidence?.linkText, 'Book a visit');
  assert.equal(cta.text, 'Book an appointment at acme.example');
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
  assert.equal(cta.text, 'Visit acme.example');
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

test('ambiguous words do not make an action: floor plans, a store locator', () => {
  assert.equal(chooseCallToAction([link('Floor Plans', '/floor-plans')], ORIGIN, 'a.example').kind, 'visit-site');
  assert.equal(chooseCallToAction([link('Store Locator', '/store-locator')], ORIGIN, 'a.example').kind, 'visit-site');
  assert.equal(chooseCallToAction([link('Find a store', '/stores/find')], ORIGIN, 'a.example').kind, 'visit-site');
});

test('an article title or a deep editorial address is not an action link', () => {
  assert.equal(chooseCallToAction([link('How to book a consultation with your accountant before tax season', '/blog/x', 'body')], ORIGIN, 'a.example').kind, 'visit-site');
  assert.equal(chooseCallToAction([link('Book a demo today', '/blog/2026/09/book-a-demo-today', 'body')], ORIGIN, 'a.example').kind, 'visit-site');
});

test('prominence and fit outweigh the configured order: the main navigation action beats an incidental body link', () => {
  const cta = chooseCallToAction([link('Book an event', '/events/book', 'body'), link('Start Free Trial', '/trial', 'nav')], ORIGIN, 'a.example');
  assert.equal(cta.label, 'Get started');
  assert.equal(cta.evidence?.linkText, 'Start Free Trial');
});

test('the configured order breaks a tie between links that are equally prominent', () => {
  const cta = chooseCallToAction([link('Contact', '/contact'), link('Book', '/book')], ORIGIN, 'a.example');
  assert.equal(cta.label, 'Book an appointment');
});

test('a site in a language the rules do not cover gets the safe fallback, not a wrong action', () => {
  const links = [link('Pricing', '/pricing')];
  assert.equal(chooseCallToAction(links, ORIGIN, 'a.example', defaultCtaRules, { language: 'hi' }).kind, 'visit-site');
  assert.equal(chooseCallToAction(links, ORIGIN, 'a.example', defaultCtaRules, { language: 'en-GB' }).label, 'See pricing');
  assert.equal(chooseCallToAction(links, ORIGIN, 'a.example', defaultCtaRules, { language: null }).label, 'See pricing');
  assert.equal(chooseCallToAction(links, ORIGIN, 'a.example', [{ label: 'Ver precios', words: ['precios'] }], { language: 'es', rulesLanguage: 'es' }).kind, 'visit-site');
});
