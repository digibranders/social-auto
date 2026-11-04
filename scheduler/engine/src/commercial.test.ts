import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyConflicts, applyFreshness, boundOf, deriveTerms, findConflicts, rangesConflict, summarizePlan } from './commercial.ts';
import { buildEvidence, type EvidenceFact } from './evidence.ts';
import { extractStructure, type PageBlock, type PageStructure } from './evidence-extract.ts';
import { chromePath } from './platform.ts';

const haveChrome = existsSync(chromePath(process.env, process.platform));
const real = { skip: haveChrome ? false : 'Chrome is not installed' };
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'evidence');
const NOW = new Date('2026-11-04T00:00:00Z');

const block = (over: Partial<PageBlock>): PageBlock => ({ id: 'b', text: '', tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const page = (url: string, blocks: Array<Partial<PageBlock>>): PageStructure => ({ url, title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: blocks.map((b, i) => block({ id: `b${i}`, ...b })) });
const card = (title: string, id: string, text: string): Partial<PageBlock> => ({ text, cardId: id, cardGroup: 'g', cardTitle: title });

test('ranges: a point inside a bound is not a conflict; a point outside is', () => {
  assert.equal(rangesConflict({ kind: 'at_most', value: 10 }, { kind: 'exact', value: 5 }), false);
  assert.equal(rangesConflict({ kind: 'at_most', value: 50 }, { kind: 'exact', value: 20 }), false);
  assert.equal(rangesConflict({ kind: 'at_most', value: 10 }, { kind: 'exact', value: 15 }), true);
  assert.equal(rangesConflict({ kind: 'exact', value: 5 }, { kind: 'exact', value: 10 }), true);
  assert.equal(rangesConflict({ kind: 'at_least', value: 30 }, { kind: 'at_most', value: 20 }), true);
  assert.equal(rangesConflict({ kind: 'at_least', value: 5 }, { kind: 'at_most', value: 20 }), false);
  assert.deepEqual(boundOf('Installation takes under 10 minutes', 10), { kind: 'at_most', value: 10 });
  assert.deepEqual(boundOf('Most teams go live in 5 minutes', 5), { kind: 'exact', value: 5 });
  assert.deepEqual(boundOf('Supports over 1,200 integrations', 1200), { kind: 'at_least', value: 1200 });
});

test('terms: price, trial, free plan and tax are separate kinds; a free plan is never a trial', () => {
  const set = buildEvidence([page('https://x.example/pricing', [
    card('Free', 'c0', 'Free forever'), card('Free', 'c0', '₹0'),
    card('Pro', 'c1', '₹999 /mo'), card('Pro', 'c1', '14-day free trial'),
    { text: 'Prices exclude GST.' },
  ])], NOW);
  const terms = deriveTerms(set.facts);
  const kinds = Object.fromEntries(terms.map((t) => [set.facts.find((f) => f.id === t.factId)?.text, t.kind]));
  assert.equal(kinds['Free forever'], 'free_plan');
  assert.equal(kinds['14-day free trial'], 'trial');
  assert.equal(kinds['₹999 /mo'], 'price');
  assert.equal(kinds['Prices exclude GST.'], 'tax');
  const pro = summarizePlan(terms, 'Pro');
  assert.equal(pro.prices[0]?.amount, 999);
  assert.equal(pro.prices[0]?.period, 'month');
  assert.equal(pro.trial?.trialDays, 14);
  assert.equal(pro.freePlan, undefined);
  assert.equal(summarizePlan(terms, 'Free').trial, undefined);
});

test('tax: a shared footnote is never attached to a plan; a note inside the plan card is', () => {
  const shared = deriveTerms(buildEvidence([page('https://x.example/p', [card('Pro', 'c0', '₹999 /mo'), card('Team', 'c1', '₹1,999 /mo'), { text: 'Prices exclude GST.' }])], NOW).facts);
  assert.equal(summarizePlan(shared, 'Pro').tax, undefined);
  const inCard = deriveTerms(buildEvidence([page('https://x.example/p', [card('Pro', 'c0', '₹999 /mo'), card('Pro', 'c0', 'Plus 18% GST at checkout.'), card('Team', 'c1', '₹1,999 /mo')])], NOW).facts);
  assert.equal(summarizePlan(inCard, 'Pro').tax?.kind, 'tax');
  assert.equal(summarizePlan(inCard, 'Team').tax, undefined);
});

test('conflicts: same plan, currency and period with another amount; different periods, plans or bounds are not conflicts', () => {
  const facts = (blocks: Array<Partial<PageBlock>>, url: string): EvidenceFact[] => buildEvidence([page(url, blocks)], NOW).facts;
  const a = facts([card('Pro', 'c0', '₹999 /mo'), card('Team', 'c1', '₹1,999 /mo')], 'https://x.example/pricing');
  const b = facts([{ text: 'The Pro plan costs ₹1,099 per month.' }], 'https://x.example/docs');
  const conflicts = findConflicts(deriveTerms([...a, ...b]));
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0]?.reason ?? '', /Pro: ₹999 against ₹1099/);
  const yearly = facts([{ text: 'The Pro plan costs ₹9,990 per year.' }], 'https://x.example/docs');
  assert.deepEqual(findConflicts(deriveTerms([...a, ...yearly])), []);
  const other = facts([{ text: 'The Team plan costs ₹1,999 per month.' }], 'https://x.example/docs');
  assert.deepEqual(findConflicts(deriveTerms([...a, ...other])), []);
  const from = facts([{ text: 'The Pro plan starts from ₹799 per month.' }], 'https://x.example/blog');
  assert.deepEqual(findConflicts(deriveTerms([...a, ...from])), []);
  const trialA = facts([card('Pro', 'c0', '14-day trial'), card('Team', 'c1', '₹5')], 'https://x.example/pricing');
  const trialB = facts([{ text: 'Start a 30-day trial of the Pro plan.' }], 'https://x.example/docs');
  assert.equal(findConflicts(deriveTerms([...trialA, ...a, ...trialB])).filter((c) => /trial/.test(c.reason)).length, 1);
});

test('applying conflicts holds every fact in the conflict; stale commercial facts are held', () => {
  const a = buildEvidence([page('https://x.example/pricing', [card('Pro', 'c0', '₹999 /mo'), card('Team', 'c1', '₹1,999 /mo')])], NOW).facts;
  const b = buildEvidence([page('https://x.example/docs', [{ text: 'The Pro plan costs ₹1,099 per month.' }])], NOW).facts;
  const { facts, conflicts } = applyConflicts([...a, ...b]);
  assert.equal(conflicts.length, 1);
  const held = facts.filter((f) => f.reasonCodes.includes('conflicting_values')).map((f) => f.text);
  assert.deepEqual(held.sort(), ['The Pro plan costs ₹1,099 per month.', '₹999 /mo'].sort());
  assert.ok(facts.filter((f) => f.text === '₹1,999 /mo').every((f) => f.status === 'usable'));
  const later = applyFreshness(a, new Date('2026-12-20T00:00:00Z'), 30);
  assert.ok(later.every((f) => f.status === 'needs_review' && f.reasonCodes.includes('stale_commercial_term')));
  assert.ok(applyFreshness(a, new Date('2026-11-20T00:00:00Z'), 30).every((f) => f.status === 'usable'));
});

test('fixture site: the docs price contradicts the pricing pages, the two setup times do not conflict, the tax note stays unattached', real, async () => {
  const structures: PageStructure[] = [];
  for (const name of ['features', 'pricing-cards', 'pricing-table', 'docs']) structures.push(await extractStructure(await readFile(join(dir, `${name}.html`), 'utf8'), `https://acme.example/${name}`));
  const { facts, conflicts } = applyConflicts(buildEvidence(structures, NOW).facts);
  // The docs price is set against the card and against the table cell: two pairs, both naming the same plan.
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((c) => /Standard: ₹1(199 against ₹1499|499 against ₹1199) per month/.test(c.reason)));
  const docs = facts.find((f) => f.text.startsWith('The Standard plan costs'));
  assert.equal(docs?.status, 'needs_review');
  assert.ok(facts.filter((f) => f.scope === 'Standard' && f.values.prices.includes('₹1199')).every((f) => f.status === 'needs_review'));
  assert.ok(facts.find((f) => f.scope === 'Starter' && f.values.prices.includes('₹599') && f.source.url.endsWith('pricing-cards'))?.status === 'usable');
  const setup = facts.filter((f) => /minutes/.test(f.text));
  assert.equal(setup.length, 2);
  assert.ok(setup.every((f) => f.status === 'usable'));
  const terms = deriveTerms(facts);
  assert.equal(summarizePlan(terms, 'Standard').tax, undefined);
  assert.equal(summarizePlan(terms, 'Starter').prices.length, 2);
});

test('a fact that is held for review never creates a conflict with a usable one', () => {
  const a = buildEvidence([page('https://x.example/pricing', [card('Pro', 'c0', '₹999 /mo'), card('Team', 'c1', '₹1,999 /mo')])], NOW).facts;
  const held = buildEvidence([page('https://x.example/docs', [{ text: 'The Pro plan costs ₹499 per month, as shown in the sample.' }])], NOW).facts;
  assert.equal(held[0]?.status, 'needs_review');
  assert.deepEqual(findConflicts(deriveTerms([...a, ...held])), []);
  assert.ok(applyConflicts([...a, ...held]).facts.filter((f) => f.status === 'usable').length >= 2);
});
