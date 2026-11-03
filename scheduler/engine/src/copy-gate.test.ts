import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCopySupported, checkCopy, withDigits, type PostCopy } from './copy-gate.ts';

const evidence = [
  'Plans start from $29 per month.',
  'The platform supports 25 integrations.',
  'Setup takes about 10 minutes.',
  'Acme is the number one choice for small clinics.',
  'Every plan has a 30-day money-back guarantee.',
];
const copy = (over: Partial<PostCopy> = {}): PostCopy => ({
  headline: 'Still chasing |late payments?|',
  subline: 'Acme sends the reminders for you.',
  caption: 'Late payments eat your week.\n\nAcme sends friendly reminders so you do not have to.\n\nStart today.',
  ...over,
});

test('copy with nothing checkable passes', () => {
  assert.deepEqual(checkCopy(copy(), evidence), []);
});

test('a figure that a verified claim states passes, however it is worded', () => {
  assert.deepEqual(checkCopy(copy({ subline: 'Acme plans start from $29 a month.' }), evidence), []);
  assert.deepEqual(checkCopy(copy({ headline: 'Plans from $29/month' }), evidence), []);
  assert.deepEqual(checkCopy(copy({ caption: 'Connect 25 integrations in one afternoon.' }), evidence), []);
});

test('an invented number is blocked, with the field and the sentence', () => {
  const found = checkCopy(copy({ headline: 'Save |12 hours| every week' }), evidence);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.field, 'headline');
  assert.match(found[0]?.reason ?? '', /12/);
});

test('a wrong price is blocked even when the number exists elsewhere in the evidence', () => {
  const found = checkCopy(copy({ subline: 'Acme starts at $25 a month.' }), evidence);
  assert.equal(found.length, 1);
  assert.match(found[0]?.reason ?? '', /\$25/);
});

test('a number the evidence gives for something else does not support the sentence', () => {
  const found = checkCopy(copy({ subline: 'Acme supports 10 integrations.' }), evidence);
  assert.equal(found.length, 1);
});

test('a missing billing period or a dropped qualifier is blocked', () => {
  assert.equal(checkCopy(copy({ subline: 'Acme costs $29 a year.' }), evidence).length, 1);
  assert.equal(checkCopy(copy({ subline: 'Acme supports up to 25 integrations.' }), evidence).length, 1);
});

test('facts mixed from different claims do not make a supported sentence', () => {
  const found = checkCopy(copy({ subline: 'Acme gives you 25 integrations for $29.' }), evidence);
  assert.equal(found.length, 1);
  assert.match(found[0]?.reason ?? '', /different claims|together/);
});

test('a superlative or guarantee must be in the evidence', () => {
  assert.equal(checkCopy(copy({ headline: 'The |best| way to get paid' }), evidence).length, 1);
  assert.equal(checkCopy(copy({ subline: 'Acme is risk-free.' }), evidence).length, 1);
  assert.deepEqual(checkCopy(copy({ subline: 'Acme is the number one choice for small clinics.' }), evidence), []);
  assert.deepEqual(checkCopy(copy({ caption: 'Every plan has a 30-day money-back guarantee.' }), evidence), []);
});

test('list-size numbers and call-to-action words are not claims', () => {
  assert.deepEqual(checkCopy(copy({ headline: '3 ways to stop chasing payments' }), evidence), []);
  assert.deepEqual(checkCopy(copy({ caption: 'Try it today.\n\nBook a demo now.' }), evidence), []);
});

test('a deadline or offer window needs evidence', () => {
  assert.equal(checkCopy(copy({ caption: 'This offer ends this week.' }), evidence).length, 1);
});

test('every sentence of the caption is checked, and each problem is reported', () => {
  const found = checkCopy(copy({ headline: '|99%| of clinics agree', caption: 'First line is fine.\n\nWe saved clients 40 hours.' }), evidence);
  assert.deepEqual(found.map((f) => f.field), ['headline', 'caption']);
});

test('with no verified claims, any figure is blocked and plain copy still passes', () => {
  assert.equal(checkCopy(copy({ subline: 'Acme handles 25 integrations.' }), []).length, 1);
  assert.deepEqual(checkCopy(copy(), []), []);
});

test('the verdict is a settings-driven function: custom words are honoured', () => {
  const found = checkCopy(copy({ subline: 'Acme is peerless.' }), evidence, { superlatives: ['peerless'] });
  assert.equal(found.length, 1);
});

test('assertCopySupported throws one message that names the post and every problem, so the model can rewrite', () => {
  assert.doesNotThrow(() => assertCopySupported(copy(), evidence, 2));
  assert.throws(
    () => assertCopySupported(copy({ headline: 'Save |12 hours|', subline: 'The best for Acme.' }), evidence, 3),
    (error: Error) => /post 3/.test(error.message) && /headline/.test(error.message) && /subline/.test(error.message) && /remove|only/.test(error.message),
  );
});

test('spelled-out numbers are numbers: "ten hours" is checked like "10 hours"', () => {
  assert.equal(checkCopy(copy({ headline: 'Save |ten hours| a week' }), evidence).length, 1);
  assert.equal(checkCopy(copy({ caption: 'Over twenty thousand clinics trust us.' }), evidence).length, 1);
  assert.deepEqual(checkCopy(copy({ subline: 'Acme sets up in about ten minutes.' }), evidence), []);
  assert.deepEqual(checkCopy(copy({ subline: 'Acme supports twenty-five integrations.' }), evidence), []);
});

test('"one" as in "one place" is not a figure', () => {
  assert.deepEqual(checkCopy(copy({ subline: 'Acme keeps it all in one place.' }), evidence), []);
});

test('formatting does not matter: $29.00, 29 USD and 25.0 match their plain forms', () => {
  assert.deepEqual(checkCopy(copy({ subline: 'Acme starts from $29.00 per month.' }), evidence), []);
  assert.deepEqual(checkCopy(copy({ subline: 'Acme supports 25 integrations.' }), ['Supports 25.0 integrations']), []);
  assert.deepEqual(checkCopy(copy({ subline: 'Acme serves 12,500 clinics.' }), ['Serves 12500 clinics']), []);
});

test('the same figure written with a different currency is blocked', () => {
  assert.equal(checkCopy(copy({ subline: 'Acme starts from €29 per month.' }), evidence).length, 1);
});

test('withDigits reads compound and scaled number words', () => {
  assert.equal(withDigits('twenty-five users'), '25 users');
  assert.equal(withDigits('twenty thousand clinics'), '20000 clinics');
  assert.equal(withDigits('one hundred and ten'), '100 and 10');
  assert.equal(withDigits('two and a half'), '2 and a half');
  assert.equal(withDigits('all in one place'), 'all in one place');
  assert.equal(withDigits('Someone phoned'), 'Someone phoned');
});

// ---- Hardening from the genericness audit
test('vague quantities need proof: "trusted by many", "thousands of", "award-winning"', () => {
  assert.equal(checkCopy(copy({ subline: 'Acme is trusted by many teams.' }), evidence).length, 1);
  assert.equal(checkCopy(copy({ caption: 'Thousands of clinics use Acme.' }), evidence).length, 1);
  assert.equal(checkCopy(copy({ subline: 'Acme is award-winning software.' }), evidence).length, 1);
  assert.equal(checkCopy(copy({ subline: 'Acme is industry-leading.' }), evidence).length, 1);
  assert.deepEqual(checkCopy(copy({ subline: 'Acme is award-winning software.' }), [...evidence, 'Acme is award-winning software.']), []);
});

test('"best practices" is advice, not a claim of leadership', () => {
  assert.deepEqual(checkCopy(copy({ headline: 'Best practices for late payments' }), evidence), []);
  assert.equal(checkCopy(copy({ headline: 'The best way to get paid' }), evidence).length, 1);
});

test('the same number for a different subject is blocked: 10,000 customers is not 10,000 products', () => {
  const found = checkCopy(copy({ subline: 'Acme has 10,000 customers.' }), ['Acme lists 10,000 products.']);
  assert.equal(found.length, 1);
  assert.match(found[0]?.reason ?? '', /10000 customer/);
});

test('a deadline is checked even though "today" alone is not', () => {
  assert.equal(checkCopy(copy({ caption: 'Offer ends today.' }), evidence).length, 1);
  assert.equal(checkCopy(copy({ caption: 'Only available until Friday.' }), evidence).length, 1);
  assert.deepEqual(checkCopy(copy({ caption: 'Start today.' }), evidence), []);
});

test('product names and standards are identifiers, not performance figures', () => {
  assert.deepEqual(checkCopy(copy({ caption: 'Works with iPhone 17 and WordPress 6.' }), evidence), []);
  assert.deepEqual(checkCopy(copy({ caption: 'Built around ISO 27001 controls.' }), evidence), []);
  // Title Case does not hide a figure.
  assert.equal(checkCopy(copy({ headline: 'Plans Start From 29 Per Month Only' }), evidence.slice(1)).length, 1);
  assert.equal(checkCopy(copy({ headline: 'UP TO 40 HOURS SAVED' }), evidence).length, 1);
});

test('Indian digit grouping is one number: 1,00,000', () => {
  assert.deepEqual(checkCopy(copy({ subline: 'Acme serves 1,00,000 users.' }), ['Serves 100000 users']), []);
  assert.equal(checkCopy(copy({ subline: 'Acme serves 1,00,000 users.' }), ['Serves 10000 users']).length, 1);
});

test('text the checker cannot read is reported as unchecked, never silently passed', () => {
  const hindi = checkCopy(copy({ subline: 'Acme आपके लिए सबसे अच्छा है।' }), evidence);
  assert.equal(hindi.length, 1);
  assert.equal(hindi[0]?.kind, 'unchecked');
  const decimalComma = checkCopy(copy({ subline: 'Acme costs 1.000,50 per month.' }), evidence);
  assert.equal(decimalComma[0]?.kind, 'unchecked');
  assert.equal(checkCopy(copy({ subline: 'Acme saves 12 hours.' }), evidence)[0]?.kind, 'unsupported');
  assert.throws(() => assertCopySupported(copy({ subline: 'Acme आपके लिए सबसे अच्छा है।' }), evidence, 1), /cannot be checked/);
});
