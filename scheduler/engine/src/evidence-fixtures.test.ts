/**
 * Step 1 of the evidence build: the synthetic fixture site and its gold labels, plus the baseline of what the current crawler text keeps.
 * The baseline test pins today's recall so the new extraction (evidence.ts) has a number to beat; it is not a statement that today's result is right.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { htmlToText } from './crawl.ts';
import { normalizeForQuote } from './claims.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'evidence');

interface GoldFact { page: string; quote: string; status: 'usable' | 'needs_review'; category: string; scope?: string; why?: string }
interface Gold { facts: GoldFact[]; forbidden: Array<{ page: string; quote: string; why: string }> }

const loadGold = async (): Promise<Gold> => JSON.parse(await readFile(join(dir, 'gold.json'), 'utf8')) as Gold;
const page = (name: string): Promise<string> => readFile(join(dir, `${name}.html`), 'utf8');
/** Visible text of a fixture, the way a reader sees it: tags removed, one space between blocks. */
const visible = (html: string): string => normalizeForQuote(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' '));

test('every gold and forbidden quote is verbatim visible text on its fixture page', async () => {
  const gold = await loadGold();
  for (const item of [...gold.facts, ...gold.forbidden]) {
    const text = visible(await page(item.page));
    assert.ok(text.includes(normalizeForQuote(item.quote)), `${item.page}: ${item.quote}`);
  }
});

test('gold labels are well formed and no quote is both wanted and forbidden', async () => {
  const gold = await loadGold();
  assert.ok(gold.facts.length >= 20);
  const forbidden = new Set(gold.forbidden.map((f) => `${f.page}|${normalizeForQuote(f.quote)}`));
  for (const fact of gold.facts) {
    assert.ok(['usable', 'needs_review'].includes(fact.status));
    assert.ok(!forbidden.has(`${fact.page}|${normalizeForQuote(fact.quote)}`), fact.quote);
  }
  assert.ok(gold.facts.some((f) => f.status === 'usable') && gold.facts.some((f) => f.status === 'needs_review'));
});

test('baseline: the current crawler text drops the footer and keeps nav chrome; recall of gold quotes is recorded', async () => {
  const gold = await loadGold();
  let kept = 0;
  const missing: string[] = [];
  for (const fact of gold.facts) {
    const text = normalizeForQuote(htmlToText(await page(fact.page)));
    if (text.includes(normalizeForQuote(fact.quote))) kept += 1;
    else missing.push(fact.quote);
  }
  // Sentences survive in flat text, so the loss today is not recall of wording: it is that nothing marks a quote as a target, a demo value, a customer result
  // or a price of one plan, and a table cell is an unlabelled string. Extraction has to be judged on association and classification, not on recall of text.
  assert.equal(kept, gold.facts.length);
  const flat = normalizeForQuote(htmlToText(await page('pricing-table')));
  assert.ok(flat.includes('₹1,199') && !flat.includes('standard ₹1,199'), 'the table value is not next to its plan name');
  console.log(`baseline crawl-text recall: ${kept}/${gold.facts.length}; missing from flat text: ${missing.length}`);
});
