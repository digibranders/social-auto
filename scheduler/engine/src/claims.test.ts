import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimType, defaultClaimConfig, normalizeForQuote, reverifyClaim, verifyClaim, verifyClaims, type ClaimInput, type PageSource } from './claims.ts';

const NOW = new Date('2026-11-03T12:00:00Z');
const RECENT = '2026-11-01T00:00:00Z';

const pages: PageSource[] = [
  { url: 'https://acme.example/integrations', fetchedAt: RECENT, text: 'Connect with 25 supported integrations. Setup takes about 10 minutes. We serve customers in 40 countries.' },
  { url: 'https://acme.example/pricing', fetchedAt: RECENT, text: 'Plans start from $29 per month, billed monthly. The Pro plan is €49 per month. Annual billing is $290 per year.' },
  { url: 'https://acme.example/trust', fetchedAt: RECENT, text: 'We do not guarantee 99.9% uptime. Our support team replies within one business day. The fastest way to reach us is chat.' },
  { url: 'https://acme.example/about', fetchedAt: RECENT, text: 'Acme is the number one choice for small clinics, according to our own survey. We are a friendly team that listens. Founded in 2012.' },
];
const claim = (text: string, sourceUrl: string, quote: string): ClaimInput => ({ text, sourceUrl, quote });
const check = (input: ClaimInput, list: PageSource[] = pages) => verifyClaim(input, list, { now: NOW });

// ---- Layer 1: the source is real
test('a real verbatim quote on a page that was read is verified, with its source recorded', () => {
  const result = check(claim('The platform supports 25 integrations.', 'https://acme.example/integrations', 'Connect with 25 supported integrations.'));
  assert.equal(result.verification.status, 'verified');
  assert.equal(result.verification.quoteFound, true);
  assert.ok(result.verification.confidence >= 0.9);
  assert.equal(result.source.url, 'https://acme.example/integrations');
  assert.equal(result.source.verbatimQuote, 'Connect with 25 supported integrations.');
  assert.match(result.source.contentHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.source.fetchedAt, RECENT);
  assert.equal(result.type, 'numeric');
});

test('an invented quote is rejected', () => {
  const result = check(claim('The platform supports 25 integrations.', 'https://acme.example/integrations', 'Connect with 25 supported integrations and 100 plugins.'));
  assert.equal(result.verification.status, 'rejected');
  assert.equal(result.verification.quoteFound, false);
  assert.ok(result.verification.confidence <= 0.2);
  assert.match(result.verification.reasons.join(' '), /quote.*not.*found/i);
});

test('a quote from a page that was never read is rejected, even if the words exist elsewhere', () => {
  const result = check(claim('Setup is quick.', 'https://acme.example/not-read', 'Setup takes about 10 minutes.'));
  assert.equal(result.verification.status, 'rejected');
  assert.match(result.verification.reasons.join(' '), /page was not read/i);
});

test('quotes match through whitespace, case, curly quotes and dashes, but the original wording is kept', () => {
  const list: PageSource[] = [{ url: 'https://acme.example/x', fetchedAt: RECENT, text: 'We’re   proud of our “friendly”\n team — they listen.' }];
  const result = check(claim('A friendly team that listens.', 'https://acme.example/x', 'We\'re proud of our "friendly" team - they listen.'), list);
  assert.equal(result.verification.quoteFound, true);
  assert.equal(normalizeForQuote('We’re   “Proud”\n—x'), 'we\'re "proud" -x');
});

test('a page that changed since the claim was recorded is flagged for re-verification', () => {
  const first = check(claim('The platform supports 25 integrations.', 'https://acme.example/integrations', 'Connect with 25 supported integrations.'));
  const changed: PageSource[] = pages.map((p) => (p.url.endsWith('/integrations') ? { ...p, text: p.text.replace('25', '30') } : p));
  const again = reverifyClaim(first, changed, { now: NOW });
  assert.equal(again.verification.status, 'rejected');
  assert.ok(again.verification.reasons.some((r) => /source.*changed|quote.*not.*found/i.test(r)));
  const sameQuoteNewText: PageSource[] = pages.map((p) => (p.url.endsWith('/integrations') ? { ...p, text: `${p.text} A new sentence was added.` } : p));
  const flagged = reverifyClaim(first, sameQuoteNewText, { now: NOW });
  assert.equal(flagged.verification.status, 'uncertain');
  assert.ok(flagged.verification.reasons.some((r) => /source.*changed/i.test(r)));
  assert.equal(reverifyClaim(first, pages, { now: NOW }).verification.status, 'verified');
});

// ---- Layer 2: the quote really supports the claim
test('a number that the quote does not contain is rejected, and each number is checked on its own', () => {
  const wrong = check(claim('The platform supports 35 integrations.', 'https://acme.example/integrations', 'Connect with 25 supported integrations.'));
  assert.equal(wrong.verification.status, 'rejected');
  const two = check(claim('Connect with 25 integrations and 10,000 customers.', 'https://acme.example/integrations', 'Connect with 25 supported integrations.'));
  assert.equal(two.verification.status, 'rejected');
  assert.match(two.verification.reasons.join(' '), /10,?000/);
});

test('numbers written differently still match: separators, decimals, percentages', () => {
  const list: PageSource[] = [{ url: 'https://acme.example/n', fetchedAt: RECENT, text: 'More than 12,500 customers rate us 4.8 out of 5, and 98% renew.' }];
  const ok = check(claim('Over 12500 customers rate us 4.8 and 98% renew.', 'https://acme.example/n', 'More than 12,500 customers rate us 4.8 out of 5, and 98% renew.'), list);
  assert.notEqual(ok.verification.status, 'rejected');
  const bad = check(claim('98.5% renew.', 'https://acme.example/n', 'and 98% renew.'), list);
  assert.equal(bad.verification.status, 'rejected');
});

test('the same number with a different unit is rejected', () => {
  const result = check(claim('We serve customers in 40 cities.', 'https://acme.example/integrations', 'We serve customers in 40 countries.'));
  assert.equal(result.verification.status, 'rejected');
  assert.match(result.verification.reasons.join(' '), /unit|cities/i);
  assert.notEqual(check(claim('We serve customers in 40 countries.', 'https://acme.example/integrations', 'We serve customers in 40 countries.')).verification.status, 'rejected');
});

test('a price must match in amount, currency and billing period', () => {
  const quote = 'Plans start from $29 per month, billed monthly.';
  assert.equal(check(claim('Plans start from $29 per month.', 'https://acme.example/pricing', quote)).verification.status, 'verified');
  assert.equal(check(claim('Plans cost $39 per month.', 'https://acme.example/pricing', quote)).verification.status, 'rejected');
  assert.equal(check(claim('Plans start from €29 per month.', 'https://acme.example/pricing', quote)).verification.status, 'rejected');
  assert.equal(check(claim('Plans start from $29 per year.', 'https://acme.example/pricing', quote)).verification.status, 'rejected');
  const priceClaim = check(claim('Plans start from $29 per month.', 'https://acme.example/pricing', quote));
  assert.equal(priceClaim.type, 'price');
  assert.deepEqual(priceClaim.extracted.currencies, ['$']);
  assert.deepEqual(priceClaim.extracted.periods, ['month']);
});

test('a claim that drops a qualifier of the quote ("from", "up to", "more than") is uncertain, and one that keeps it is verified', () => {
  const dropped = check(claim('Plans cost $29 per month.', 'https://acme.example/pricing', 'Plans start from $29 per month, billed monthly.'));
  assert.equal(dropped.verification.status, 'uncertain');
  assert.match(dropped.verification.reasons.join(' '), /qualifier.*from/i);
  const kept = check(claim('Plans start from $29 per month.', 'https://acme.example/pricing', 'Plans start from $29 per month, billed monthly.'));
  assert.equal(kept.verification.status, 'verified');
});

test('a quote that negates the claim does not support it, even though the numbers match', () => {
  const result = check(claim('We guarantee 99.9% uptime.', 'https://acme.example/trust', 'We do not guarantee 99.9% uptime.'));
  assert.equal(result.verification.status, 'rejected');
  assert.match(result.verification.reasons.join(' '), /negat/i);
});

// ---- Layer 3: rules for the kind of claim
test('a superlative needs the source itself to make it, and says whose claim it is', () => {
  const unsupported = check(claim('Acme is the best choice for clinics.', 'https://acme.example/integrations', 'Connect with 25 supported integrations.'));
  assert.equal(unsupported.verification.status, 'rejected');
  const sourced = check(claim('Acme is the number one choice for small clinics.', 'https://acme.example/about', 'Acme is the number one choice for small clinics, according to our own survey.'));
  assert.equal(sourced.type, 'superlative');
  assert.notEqual(sourced.verification.status, 'rejected');
  const stretched = check(claim('Acme is the best choice for clinics.', 'https://acme.example/about', 'Acme is the number one choice for small clinics, according to our own survey.'));
  assert.equal(stretched.verification.status, 'rejected', 'a different superlative is not the one the source made');
});

test('a guarantee needs an explicit guarantee in the source', () => {
  const result = check(claim('Results are guaranteed.', 'https://acme.example/trust', 'Our support team replies within one business day.'));
  assert.equal(result.verification.status, 'rejected');
  assert.equal(result.type, 'guarantee');
});

test('a time-sensitive claim needs recent evidence', () => {
  const stale: PageSource[] = [{ url: 'https://acme.example/offer', fetchedAt: '2025-01-01T00:00:00Z', text: 'Our spring sale is on now with free setup.' }];
  const old = check(claim('Our sale is on now with free setup.', 'https://acme.example/offer', 'Our spring sale is on now with free setup.'), stale);
  assert.equal(old.type, 'time_sensitive');
  assert.equal(old.verification.status, 'uncertain');
  const fresh = check(claim('Our sale is on now with free setup.', 'https://acme.example/offer', 'Our spring sale is on now with free setup.'), [{ ...stale[0] as PageSource, fetchedAt: RECENT }]);
  assert.equal(fresh.verification.status, 'verified');
});

test('subjective wording is allowed without measurable proof, and editorial numbers ("3 ways") are not facts to prove', () => {
  const friendly = check(claim('A friendly team that listens.', 'https://acme.example/about', 'We are a friendly team that listens.'));
  assert.equal(friendly.type, 'subjective');
  assert.equal(friendly.verification.status, 'verified');
  assert.equal(claimType('3 ways to improve your week', defaultClaimConfig), 'subjective');
  assert.equal(claimType('5 signs a project is slipping', defaultClaimConfig), 'subjective');
  assert.equal(claimType('Improve productivity by 30%', defaultClaimConfig), 'numeric');
  assert.equal(claimType('From $9 per month', defaultClaimConfig), 'price');
  assert.equal(claimType('The fastest way to reach us', defaultClaimConfig), 'superlative');
  assert.equal(claimType('100% money-back guarantee', defaultClaimConfig), 'guarantee');
  assert.equal(claimType('Founded in 2012', defaultClaimConfig), 'numeric');
  assert.equal(claimType('Our support team replies within one business day', defaultClaimConfig), 'capability');
});

test('confidence comes from the checks that passed, never from what the model said', () => {
  const input = { ...claim('The platform supports 25 integrations.', 'https://acme.example/integrations', 'Connect with 25 supported integrations.'), confidence: 1, status: 'verified' } as ClaimInput;
  const good = check(input);
  const dropped = check(claim('Plans cost $29 per month.', 'https://acme.example/pricing', 'Plans start from $29 per month, billed monthly.'));
  const bad = check(claim('We serve 99 countries.', 'https://acme.example/integrations', 'We serve customers in 40 countries.'));
  assert.ok(good.verification.confidence > dropped.verification.confidence && dropped.verification.confidence > bad.verification.confidence);
  assert.ok(good.verification.confidence <= 1 && bad.verification.confidence >= 0);
  assert.ok(!('confidence' in good) && !('status' in good), 'only the checked result is returned');
});

// ---- configurable, industry-agnostic
test('every list of words is a setting, so a client or language can bring its own', () => {
  const list: PageSource[] = [{ url: 'https://acme.example/x', fetchedAt: RECENT, text: 'We are unrivalled in our field.' }];
  assert.equal(verifyClaim(claim('We are unrivalled in our field.', 'https://acme.example/x', 'We are unrivalled in our field.'), list, { now: NOW }).type, 'subjective');
  const configured = verifyClaim(claim('We are unrivalled in our field.', 'https://acme.example/x', 'We are unrivalled in our field.'), list, { now: NOW, config: { superlatives: [...defaultClaimConfig.superlatives, 'unrivalled'] } });
  assert.equal(configured.type, 'superlative');
  assert.equal(typeof defaultClaimConfig.maxAgeDays, 'number');
  for (const word of ['treatment', 'patients', 'saas', 'recipe', 'clinic', 'doctor', 'insurance']) {
    assert.ok(![...defaultClaimConfig.superlatives, ...defaultClaimConfig.qualifiers, ...defaultClaimConfig.guarantees, ...defaultClaimConfig.editorialNouns].includes(word), word);
  }
});

test('a batch is sorted into verified, uncertain and rejected, with every claim accounted for', () => {
  const batch = [
    claim('The platform supports 25 integrations.', 'https://acme.example/integrations', 'Connect with 25 supported integrations.'),
    claim('Plans cost $29 per month.', 'https://acme.example/pricing', 'Plans start from $29 per month, billed monthly.'),
    claim('We serve 99 countries.', 'https://acme.example/integrations', 'We serve customers in 40 countries.'),
  ];
  const result = verifyClaims(batch, pages, { now: NOW });
  assert.deepEqual([result.verified.length, result.uncertain.length, result.rejected.length], [1, 1, 1]);
  assert.equal(result.all.length, 3);
});

test('a price written with trailing zeros is the same price', () => {
  const list: PageSource[] = [{ url: 'https://acme.example/p', fetchedAt: RECENT, text: 'Plans start from $29.00 per month.' }];
  assert.equal(check(claim('Plans start from $29 per month.', 'https://acme.example/p', 'Plans start from $29.00 per month.'), list).verification.status, 'verified');
  assert.equal(check(claim('Plans start from $29.50 per month.', 'https://acme.example/p', 'Plans start from $29.00 per month.'), list).verification.status, 'rejected');
});

test('a claim that says the opposite of a plain quote is rejected, whichever of the two carries the negation', () => {
  const list: PageSource[] = [{ url: 'https://acme.example/t', fetchedAt: RECENT, text: 'Our team answers every question. We offer refunds.' }];
  const claimNegates = check(claim('Our team never answers questions.', 'https://acme.example/t', 'Our team answers every question.'), list);
  assert.equal(claimNegates.verification.status, 'rejected');
  assert.match(claimNegates.verification.reasons.join(' '), /negat|opposite/i);
  const quoteNegates = check(claim('We offer refunds.', 'https://acme.example/t2', 'We do not offer refunds.'), [{ url: 'https://acme.example/t2', fetchedAt: RECENT, text: 'We do not offer refunds.' }]);
  assert.equal(quoteNegates.verification.status, 'rejected');
  const bothNegated = check(claim('We do not offer refunds.', 'https://acme.example/t2', 'We do not offer refunds.'), [{ url: 'https://acme.example/t2', fetchedAt: RECENT, text: 'We do not offer refunds.' }]);
  assert.equal(bothNegated.verification.status, 'verified');
});

test('a claim that shares little wording with its quote needs review, while a faithful paraphrase passes', () => {
  const list: PageSource[] = [{ url: 'https://acme.example/p', fetchedAt: RECENT, text: 'Plans start from $29 per month. Our team answers every question.' }];
  const stray = check(claim('Plans are free for everyone.', 'https://acme.example/p', 'Plans start from $29 per month.'), list);
  assert.equal(stray.verification.status, 'uncertain');
  assert.match(stray.verification.reasons.join(' '), /little wording|needs review/i);
  assert.equal(check(claim('Our team responds to every question.', 'https://acme.example/p', 'Our team answers every question.'), list).verification.status, 'verified');
});

test('a negation in another sentence of the quote does not count against a claim', () => {
  const list: PageSource[] = [{ url: 'https://acme.example/f', fetchedAt: RECENT, text: 'No setup fees. We offer refunds.' }];
  assert.equal(check(claim('We offer refunds.', 'https://acme.example/f', 'No setup fees. We offer refunds.'), list).verification.status, 'verified');
});
