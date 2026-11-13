import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCustomerText, customerFactsOf, factsForTopic, factsOfStatement, isCustomerFact, readStatements, saveStatement, statementUrl } from './customer-facts.ts';

const at = '2026-11-13T05:00:00.000Z';
const statement = (id: string, text: string) => ({ id, text, by: 'user_42', at });

test('her own plain words are usable; what needs proof, a link, or too little is refused with a sentence to show', () => {
  assert.equal(checkCustomerText('Diwali special: 20% off all thalis until 2 Nov.'), null);
  assert.match(checkCustomerText('hi') ?? '', /a little more/);
  assert.match(checkCustomerText('x'.repeat(1001)) ?? '', /under 1000/);
  assert.match(checkCustomerText('See https://currycook.com/diwali for the 20% off offer') ?? '', /Links are not read/);
  assert.match(checkCustomerText(42) ?? '', /Write what the post is about/);
  assert.match(checkCustomerText('The best thali in town, 20% off this week') ?? '', /"best" is a claim that needs proof/);
  assert.match(checkCustomerText('Guaranteed delivery in 30 minutes for every order') ?? '', /guarantee/);
  for (const text of ['We are ISO 9001 certified and now cheaper than anyone', 'Over 5,000 happy customers choose our thali every week', 'Our herbal tea cures colds and treats migraine', 'Our thali is better than the other restaurants in town']) {
    assert.match(checkCustomerText(text) ?? '', /needs proof/, text);
  }
});

test('a statement becomes usable facts whose source is her statement, with her text kept exactly', () => {
  const facts = factsOfStatement(statement('t-1', 'Diwali special: 20% off all thalis until 2 Nov.'));
  assert.ok(facts.length >= 1);
  for (const f of facts) {
    assert.equal(f.status, 'usable');
    assert.equal(f.source.url, statementUrl('t-1'));
    assert.equal(f.source.context, 'Written by the customer');
    assert.ok(!f.reasonCodes.includes('flat_text_only'));
    assert.ok(isCustomerFact(f));
    assert.equal(f.capturedAt, at);
  }
  assert.ok(facts.some((f) => f.values.numbers.includes('20%')), JSON.stringify(facts.map((f) => f.values)));
  assert.ok(facts.map((f) => f.text).join(' ').includes('20% off all thalis until 2 Nov'));
});

test('statements are kept beside the brand, in order, and only the facts of the topic asked for are used for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-facts-'));
  try {
    assert.deepEqual(readStatements(dir), []);
    assert.ok(saveStatement(dir, statement('t-1', 'Diwali special: 20% off all thalis until 2 Nov.')));
    assert.ok(saveStatement(dir, statement('t-2', 'New dish: paneer kulcha, served from Monday.')));
    assert.deepEqual(readStatements(dir).map((s) => s.id), ['t-1', 't-2']);
    assert.match(readFileSync(join(dir, 'customer-facts.json'), 'utf8'), /20% off all thalis until 2 Nov/);
    const all = customerFactsOf(dir);
    const one = factsForTopic([...all, { ...(all[0] as (typeof all)[number]), id: 'site-fact', source: { ...(all[0] as (typeof all)[number]).source, url: 'https://currycook.com/' } }], 't-2');
    assert.ok(one.length >= 1);
    assert.ok(one.every((f) => f.source.url === statementUrl('t-2')));
    assert.equal(saveStatement(dir, statement('t-3', '...')), null, 'text with no sentence to write from is not kept');
    assert.equal(readStatements(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
