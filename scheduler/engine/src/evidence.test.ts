import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeForQuote } from './claims.ts';
import { buildEvidence, displayFact, flatTextEvidence, pageRoleOf, quoteStillOnPage, sentencesOf, type EvidenceFact, type EvidenceSet } from './evidence.ts';
import { extractStructure, parseStructure, wrapForExtraction, StructureError, type PageBlock, type PageStructure } from './evidence-extract.ts';
import { chromePath } from './platform.ts';

const haveChrome = existsSync(chromePath(process.env, process.platform));
const real = { skip: haveChrome ? false : 'Chrome is not installed' };
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'evidence');
const NOW = new Date('2026-11-04T00:00:00Z');
const PAGES = ['home', 'features', 'pricing-cards', 'pricing-table', 'case-studies', 'docs', 'mockups'];

interface Gold { facts: Array<{ page: string; quote: string; status: 'usable' | 'needs_review'; category: string; scope?: string }>; forbidden: Array<{ page: string; quote: string }> }

const urlOf = (page: string): string => `https://acme.example/${page === 'home' ? '' : page}`;
const pageOf = (fact: EvidenceFact): string => (new URL(fact.source.url).pathname.slice(1) || 'home');

async function fixtureEvidence(): Promise<EvidenceSet> {
  const structures: PageStructure[] = [];
  for (const name of PAGES) structures.push(await extractStructure(await readFile(join(dir, `${name}.html`), 'utf8'), urlOf(name)));
  return buildEvidence(structures, NOW);
}

const same = (fact: EvidenceFact, item: { page: string; quote: string }): boolean => {
  const a = normalizeForQuote(fact.text);
  const b = normalizeForQuote(item.quote);
  return pageOf(fact) === item.page && (a.includes(b) || b.includes(a));
};

const block = (over: Partial<PageBlock>): PageBlock => ({ id: 'b', text: '', tag: 'p', region: 'prose', isHeading: false, headingText: '', chrome: '', cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: 'en', ...over });
const structure = (blocks: Array<Partial<PageBlock>>, url = 'https://acme.example/features'): PageStructure => ({ url, title: '', lang: 'en', truncated: false, unstyled: false, variantSwitch: false, htmlHash: '', blocks: blocks.map((b, i) => block({ id: `b${i}`, ...b })) });

test('fixture site: precision and recall against the gold labels, forbidden items never usable', real, async () => {
  const gold = JSON.parse(await readFile(join(dir, 'gold.json'), 'utf8')) as Gold;
  const set = await fixtureEvidence();
  const usable = set.facts.filter((f) => f.status === 'usable');

  const missed: string[] = [];
  for (const item of gold.facts) {
    const found = set.facts.filter((f) => same(f, item) && (item.scope === undefined || f.scope === item.scope));
    if (!found.some((f) => f.status === item.status)) missed.push(`${item.page}: ${item.quote} (wanted ${item.status}, got ${found.map((f) => f.status).join('/') || 'nothing'})`);
  }
  const wrong = usable.filter((f) => !gold.facts.some((item) => item.status === 'usable' && same(f, item) && (item.scope === undefined || f.scope === item.scope)));
  const leaked = usable.filter((f) => gold.forbidden.some((item) => same(f, item)));

  const recall = (gold.facts.length - missed.length) / gold.facts.length;
  const precision = (usable.length - wrong.length) / usable.length;
  console.log(`fixture evidence: ${set.facts.length} facts, ${usable.length} usable; precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}`);
  assert.deepEqual(missed, []);
  assert.deepEqual(wrong.map((f) => f.text), []);
  assert.deepEqual(leaked.map((f) => f.text), []);
  assert.equal(precision, 1);
  assert.equal(recall, 1);
});

test('plan, price and period are tied to their card and to their table cell with no wrong association', real, async () => {
  const set = await fixtureEvidence();
  const at = (page: string, text: string, scope: string): EvidenceFact | undefined => set.facts.find((f) => pageOf(f) === page && f.text.startsWith(text) && f.scope === scope);
  for (const [plan, price] of [['Starter', '₹599'], ['Standard', '₹1,199'], ['Professional', '₹2,999']] as const) {
    const card = at('pricing-cards', price, plan);
    const cell = at('pricing-table', price, plan);
    assert.equal(card?.associationStatus, 'confirmed', plan);
    assert.equal(cell?.associationStatus, 'confirmed', plan);
    assert.deepEqual(card?.values.prices, [price.replace(',', '')]);
    assert.equal(cell?.label, 'Price per month');
  }
  assert.deepEqual(at('pricing-cards', '₹599', 'Starter')?.values.periods, ['month']);
  assert.equal(at('pricing-table', '7 days', 'Professional')?.label, 'Free trial');
  assert.equal(at('pricing-table', '14 days', 'Standard')?.label, 'Free trial');
  // No price is attached to a plan it does not belong to.
  assert.equal(set.facts.filter((f) => f.scope === 'Starter' && f.values.prices.includes('₹1,199')).length, 0);
  assert.equal(displayFact(at('pricing-table', '₹1,199', 'Standard') as EvidenceFact), 'Standard · Price per month: ₹1,199');
});

test('qualifiers are kept, short fragments are kept, and the shared tax note is held for review', real, async () => {
  const set = await fixtureEvidence();
  const find = (text: string): EvidenceFact | undefined => set.facts.find((f) => f.text === text);
  assert.deepEqual(find('Up to 50 users')?.qualifiers, ['up to']);
  assert.equal(find('Free forever')?.status, 'usable');
  assert.equal(find('No credit card required.')?.status, 'usable');
  for (const text of ['Prices exclude GST.', '18% GST is added at checkout.']) {
    assert.equal(find(text)?.status, 'needs_review', text);
    assert.ok(find(text)?.reasonCodes.includes('tax_scope_unconfirmed'));
    assert.equal(find(text)?.associationStatus, 'unknown');
  }
});

test('targets, demo values, figure strips, customer results, multi-claim sentences and other languages are held, with a reason', real, async () => {
  const set = await fixtureEvidence();
  const reasons = (needle: string): string[] => set.facts.find((f) => f.text.includes(needle))?.reasonCodes ?? ['missing'];
  assert.ok(reasons('99.9% uptime target').includes('target_not_guarantee'));
  assert.ok(reasons('87 leads').includes('demo_context'));
  assert.ok(reasons('12,000+').includes('stat_strip'));
  assert.ok(reasons('98% answered').includes('stat_strip'));
  assert.ok(reasons('Northwind Dental').includes('customer_result'));
  assert.equal(set.facts.find((f) => f.text.includes('Northwind Dental'))?.attribution, 'customer');
  assert.ok(reasons('Plans start at').includes('multi_claim'));
  assert.ok(reasons('cut first-reply time').includes('multi_claim'));
  assert.ok(reasons('responde a las preguntas').includes('language_unsupported'));
  assert.equal(set.facts.find((f) => f.text.includes('87 leads'))?.intent, 'example');
  assert.equal(set.facts.find((f) => f.text.includes('uptime target'))?.intent, 'target');
});

test('navigation, footer and headings are not facts but are recorded as excluded; the page snapshot keeps every block', real, async () => {
  const set = await fixtureEvidence();
  assert.ok(!set.facts.some((f) => /Privacy|Log in|All rights reserved/.test(f.text)));
  assert.ok(set.excluded.some((e) => e.reason === 'nav'));
  assert.ok(set.excluded.some((e) => e.reason === 'footer' && /All rights reserved/.test(e.text)));
  const pricing = set.snapshots.find((s) => s.url.endsWith('pricing-cards'));
  assert.match(pricing?.text ?? '', /Log in/);
  assert.ok(set.facts.every((f) => quoteStillOnPage(f, set.snapshots)));
  assert.ok(set.facts.every((f) => f.source.contentHash.startsWith('sha256:') && f.source.quote === f.text));
});

test('the page cannot run its own scripts while its structure is read', real, async () => {
  const html = '<html lang="en"><body><main><p>Honest line about the product.</p></main><script>document.body.insertAdjacentHTML("beforeend","<p>INJECTED by the page</p>")</script></body></html>';
  const s = await extractStructure(html, 'https://acme.example/x');
  assert.ok(s.blocks.some((b) => b.text.includes('Honest line')));
  assert.ok(!s.blocks.some((b) => b.text.includes('INJECTED')));
});

test('hidden content is not read', real, async () => {
  const html = '<html lang="en"><body><main><p>Visible sentence here.</p><p hidden>Secret hidden sentence.</p><p style="display:none">Also hidden text.</p><p aria-hidden="true">Aria hidden text.</p></main></body></html>';
  const s = await extractStructure(html, 'https://acme.example/x');
  assert.deepEqual(s.blocks.map((b) => b.text), ['Visible sentence here.']);
});

test('a structure that is missing, incomplete or malformed is refused', () => {
  assert.throws(() => parseStructure('<html></html>', 'u'), StructureError);
  assert.throws(() => parseStructure('<script type="application/json" id="evidence-blocks">{nope</script>', 'u'), /not valid JSON/);
  assert.throws(() => parseStructure('<script type="application/json" id="evidence-blocks">{"done":false,"errors":["boom"],"blocks":[]}</script>', 'u'), /boom/);
  assert.throws(() => parseStructure('<script type="application/json" id="evidence-blocks">{"done":true,"errors":[],"blocks":[{"text":1}]}</script>', 'u'), StructureError);
  const ok = parseStructure('<script type="application/json" id="evidence-blocks">{"done":true,"errors":[],"title":"T","lang":"en","blocks":[],"truncated":false}</script>', 'u');
  assert.equal(ok.title, 'T');
});

test('the page is wrapped under a policy that allows only the structure script', () => {
  const wrapped = wrapForExtraction('<p>x</p>', 'n0nce');
  assert.match(wrapped, /Content-Security-Policy/);
  assert.match(wrapped, /script-src 'nonce-n0nce'/);
  assert.match(wrapped, /default-src 'none'/);
  assert.match(wrapped, /<script nonce="n0nce">/);
});

test('flat text only: every fact is held for review and says so', () => {
  const set = flatTextEvidence('https://acme.example/pricing', 'Standard plan is ₹1,199 per month.\nNo credit card required.', NOW);
  assert.ok(set.facts.length >= 2);
  assert.ok(set.facts.every((f) => f.status === 'needs_review' && f.reasonCodes.includes('flat_text_only')));
});

test('unit: classification from hand-built blocks', () => {
  const set = buildEvidence([structure([
    { text: 'We reduced support cost by 30% last year.' },
    { text: 'Our uptime goal is 99.99% every month.' },
    { text: 'Free', cardId: 'c1', cardGroup: 'g', cardTitle: 'Free' },
    { text: '0 users', cardId: 'c1', cardGroup: 'g', cardTitle: 'Free' },
    { text: '5 users', cardId: 'c2', cardGroup: 'g', cardTitle: 'Team' },
    { text: 'ISO 27001 certified since 2022.' },
  ])], NOW);
  const by = (needle: string): EvidenceFact => set.facts.find((f) => f.text.includes(needle)) as EvidenceFact;
  assert.equal(by('reduced support').category, 'outcome');
  // A result the site claims for itself is held from the automatic flow (proof-hold.ts), however well it is quoted.
  assert.equal(by('reduced support').status, 'needs_review');
  assert.equal(by('reduced support').proofHold?.code, 'HOLD_PERFORMANCE');
  assert.deepEqual(by('uptime goal').reasonCodes, ['target_not_guarantee']);
  assert.equal(by('5 users').scope, 'Team');
  assert.equal(by('ISO 27001').category, 'credential');
  assert.equal(by('ISO 27001').proofHold?.code, 'HOLD_CREDENTIAL');
});

test('unit: repeated furniture across pages is excluded but a repeated figure is kept', () => {
  const pages = ['a', 'b', 'c'].map((p) => structure([{ text: 'Trusted by teams worldwide today.' }, { text: 'From ₹599 per month.' }, { text: `Only on page ${p}.` }], `https://acme.example/${p}`));
  const set = buildEvidence(pages, NOW);
  assert.ok(!set.facts.some((f) => f.text.startsWith('Trusted by')));
  assert.equal(set.excluded.filter((e) => e.reason === 'repeated_across_pages').length, 3);
  assert.equal(set.facts.filter((f) => f.text.includes('₹599')).length, 3);
});

test('unit: sentence splitting and page roles', () => {
  assert.deepEqual(sentencesOf('Prices exclude GST. 18% GST is added at checkout.'), ['Prices exclude GST.', '18% GST is added at checkout.']);
  assert.deepEqual(sentencesOf('Version 2.5 is out'), ['Version 2.5 is out']);
  assert.equal(pageRoleOf('https://x.example/'), 'home');
  assert.equal(pageRoleOf('https://x.example/pricing'), 'pricing');
  assert.equal(pageRoleOf('https://x.example/case-studies/acme'), 'case_study');
  assert.equal(pageRoleOf('https://x.example/blog/post'), 'other');
});

const adversarial = async (name: string, deps: { styles?: string[] } = {}): Promise<EvidenceSet> => {
  const html = await readFile(join(dir, `${name}.html`), 'utf8');
  return buildEvidence([await extractStructure(html, `https://zeta.example/${name}`, deps)], NOW);
};

test('adversarial: a transposed table is never trusted as plan, price and users; the toggle is noticed', real, async () => {
  const set = await adversarial('adv-transposed');
  const cells = set.facts.filter((f) => f.label !== undefined);
  assert.ok(cells.length >= 4);
  // The column header "Price" is not an entity named anywhere else on the site, so every derived cell is held and marked inferred.
  assert.ok(cells.every((f) => f.status === 'needs_review' && f.associationStatus === 'inferred' && f.reasonCodes.includes('table_axis_unconfirmed')));
  assert.ok(set.facts.find((f) => f.text === '₹599')?.reasonCodes.includes('billing_variant_unconfirmed'));
  assert.ok(!set.facts.find((f) => f.text === '₹1,299 /mo')?.reasonCodes.includes('billing_variant_unconfirmed'));
});

test('adversarial: a table whose entities are named elsewhere on the site is confirmed', real, async () => {
  const withNames = buildEvidence([
    await extractStructure(await readFile(join(dir, 'pricing-table.html'), 'utf8'), 'https://acme.example/pricing-table'),
    await extractStructure('<html lang="en"><body><main><h2>Starter</h2><h2>Standard</h2><h2>Professional</h2></main></body></html>', 'https://acme.example/plans'),
  ], NOW);
  const cell = withNames.facts.find((f) => f.scope === 'Standard' && f.label === 'Price per month');
  assert.equal(cell?.associationStatus, 'confirmed');
  assert.equal(cell?.status, 'usable');
});

test('adversarial: a grid of nested plan wrappers with free and contact-sales cards keeps each fact with its own plan', real, async () => {
  const set = await adversarial('adv-grid');
  const scopeOf = (text: string): string | undefined => set.facts.find((f) => f.text === text)?.scope;
  assert.equal(scopeOf('₹999 /mo'), 'Pro');
  assert.equal(scopeOf('14-day trial'), 'Pro');
  assert.equal(scopeOf('Core features for one person.'), 'Free');
  assert.equal(scopeOf('Contact sales for a quote.'), 'Enterprise');
});

test('adversarial: a price hidden by the page stylesheet is dropped once the stylesheet is applied, and held when it is not', real, async () => {
  const unstyled = await adversarial('adv-hidden');
  assert.ok(unstyled.facts.length >= 2);
  assert.ok(unstyled.facts.every((f) => f.status === 'needs_review' && f.reasonCodes.includes('styles_not_applied')));
  const styled = await adversarial('adv-hidden', { styles: ['.old{display:none}'] });
  assert.deepEqual(styled.facts.map((f) => f.text), ['The plan costs ₹599 per month.']);
  assert.equal(styled.facts[0]?.status, 'usable');
  assert.match(styled.snapshots[0]?.htmlHash ?? '', /^sha256:/);
});

test('headings with a figure or commercial wording are candidates; plain labels are not', () => {
  const set = buildEvidence([structure([
    { text: 'Plans from ₹599/month', isHeading: true },
    { text: 'Free forever', isHeading: true },
    { text: 'Features', isHeading: true },
    { text: 'Simple pricing for teams', isHeading: true },
  ])], NOW);
  assert.deepEqual(set.facts.map((f) => f.text).sort(), ['Free forever', 'Plans from ₹599/month'].sort());
  assert.ok(set.excluded.some((e) => e.text === 'Features' && e.reason === 'heading'));
  assert.ok(set.excluded.some((e) => e.text === 'Simple pricing for teams' && e.reason === 'heading'));
});
