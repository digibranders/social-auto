/**
 * Evidence facts: what a site states, kept as the exact words on its pages (quote as fact), with what the page's structure says about each:
 * its source and heading, the plan or card it belongs to, the table row and column it sits under, whether it is a target, a demo value, a
 * strip of figures or a customer's result. A fact is `usable` only when nothing in that structure makes it doubtful; anything doubtful is
 * `needs_review` with coded reasons, never silently dropped and never silently accepted.
 *
 * What this does not do: it does not prove that prose means what its source means, and for tables it takes the column header as the entity
 * and the row header as the attribute (a table laid out the other way round keeps both labels in the source context for a person to read).
 * Every list of words is a setting, so nothing here belongs to an industry or a language.
 */
import { createHash } from 'node:crypto';
import { defaultClaimConfig, extractFacts, normalizeForQuote, type ClaimConfig } from './claims.ts';
import type { PageBlock, PageStructure } from './evidence-extract.ts';

export type EvidenceCategory = 'identity' | 'capability' | 'process' | 'offer' | 'commercial_term' | 'outcome' | 'credential' | 'testimonial' | 'educational';
export type PageRole = 'home' | 'pricing' | 'features' | 'docs' | 'case_study' | 'other';
export type FactStatus = 'usable' | 'needs_review';
export type Association = 'confirmed' | 'inferred' | 'unknown';
export type FactIntent = 'claim' | 'target' | 'example';
export type FactAttribution = 'brand' | 'customer';

export type ReasonCode =
  | 'demo_context'
  | 'target_not_guarantee'
  | 'stat_strip'
  | 'bare_number'
  | 'customer_result'
  | 'multi_claim'
  | 'language_unsupported'
  | 'tax_scope_unconfirmed'
  | 'scope_unconfirmed'
  | 'too_long'
  | 'flat_text_only';

export interface EvidenceFact {
  id: string;
  category: EvidenceCategory;
  /** The exact words on the page. */
  text: string;
  /** The plan, card or table column this fact belongs to, when the page's structure says so. */
  scope?: string;
  /** The table row label, when the fact is a cell. */
  label?: string;
  qualifiers: string[];
  source: {
    url: string;
    contentHash: string;
    quote: string;
    context: string;
    heading: string;
    regionType: 'prose' | 'table' | 'list' | 'ui';
    pageRole: PageRole;
  };
  associationStatus: Association;
  attribution: FactAttribution;
  intent: FactIntent;
  values: { numbers: string[]; prices: string[]; currencies: string[]; periods: string[]; units: Array<[string, string]> };
  language: string;
  status: FactStatus;
  reasonCodes: ReasonCode[];
  capturedAt: string;
}

export interface ExcludedBlock {
  url: string;
  text: string;
  reason: 'nav' | 'header' | 'footer' | 'aside' | 'heading' | 'repeated_across_pages' | 'too_short' | 'page_cap' | 'duplicate';
}

export interface PageSnapshot {
  url: string;
  title: string;
  pageRole: PageRole;
  contentHash: string;
  /** The text the quotes are checked against: every block of the page, in order. */
  text: string;
}

export interface EvidenceConfig {
  /** Language subtags a fact may be used automatically in. */
  supportedLanguages: readonly string[];
  /** Page role by address: the first pattern that matches the path decides. */
  pageRoles: ReadonlyArray<readonly [PageRole, RegExp]>;
  /** Words that make a number a target, not a promise. */
  targetWords: readonly string[];
  /** Words that mark a value as an illustration. */
  demoWords: readonly string[];
  taxWords: readonly string[];
  commercialWords: readonly string[];
  processWords: readonly string[];
  credentialWords: readonly string[];
  outcomeWords: readonly string[];
  maxFactsPerPage: number;
  maxSentenceChars: number;
  /** A sentence on this many pages, with no figure in it, is site furniture. */
  repeatedAcrossPages: number;
  claim: ClaimConfig;
}

export const defaultEvidenceConfig: EvidenceConfig = {
  supportedLanguages: ['en'],
  pageRoles: [
    ['case_study', /case-?stud|customer|stories|success|testimonial/i],
    ['pricing', /pric|plans?(\/|$)|billing/i],
    ['docs', /docs?(\/|$)|documentation|help|guide/i],
    ['features', /features?|product|solutions?|integrations?|how-it-works/i],
  ],
  targetWords: ['target', 'goal', 'aim', 'aims', 'projected', 'expected', 'estimated', 'forecast', 'objective'],
  demoWords: ['sample', 'demo', 'mock', 'mockup', 'example', 'placeholder', 'dummy', 'lorem'],
  taxWords: ['gst', 'vat', 'tax', 'taxes'],
  commercialWords: ['free', 'trial', 'credit card', 'per month', 'per year', 'billed', 'billing', 'refund', 'discount', 'plan', 'plans', 'pricing', 'price', 'prices', 'subscription', 'checkout', 'cancel'],
  processWords: ['install', 'installation', 'setup', 'set up', 'onboard', 'get started', 'go live', 'live bot', 'signup', 'sign up', 'migrate', 'script tag'],
  credentialWords: ['certified', 'certification', 'iso', 'soc 2', 'accredited', 'award', 'compliant', 'compliance', 'gdpr', 'hipaa'],
  outcomeWords: ['increase', 'increased', 'reduce', 'reduced', 'cut', 'saved', 'resolved', 'booked', 'handled', 'grew', 'improved', 'doubled'],
  maxFactsPerPage: 120,
  maxSentenceChars: 400,
  repeatedAcrossPages: 3,
  claim: defaultClaimConfig,
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export function pageRoleOf(url: string, config: EvidenceConfig = defaultEvidenceConfig): PageRole {
  let path = '/';
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  if (path.replace(/\/+$/, '') === '') return 'home';
  for (const [role, pattern] of config.pageRoles) if (pattern.test(path)) return role;
  return 'other';
}

const wordPattern = (words: readonly string[]): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const hasDigit = (text: string): boolean => /\p{N}/u.test(text);
const hasLetters = (text: string): boolean => /\p{L}/u.test(text.replace(/[$€£₹¥]/g, ''));

/** Sentences of a block, each a verbatim stretch of it. */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(])/u).map((s) => s.trim()).filter(Boolean);
}

interface Classified {
  category: EvidenceCategory;
  intent: FactIntent;
  attribution: FactAttribution;
}

function classify(text: string, pageRole: PageRole, hasNumbers: boolean, hasPrice: boolean, config: EvidenceConfig, target: boolean, demo: boolean): Classified {
  const attribution: FactAttribution = pageRole === 'case_study' ? 'customer' : 'brand';
  const intent: FactIntent = demo ? 'example' : target ? 'target' : 'claim';
  let category: EvidenceCategory = 'capability';
  if (pageRole === 'case_study') category = hasNumbers ? 'outcome' : 'testimonial';
  else if (hasPrice || wordPattern(config.commercialWords).test(text) || wordPattern(config.taxWords).test(text) || (pageRole === 'pricing' && hasNumbers)) category = 'commercial_term';
  else if (wordPattern(config.credentialWords).test(text)) category = 'credential';
  else if (hasNumbers && wordPattern(config.outcomeWords).test(text)) category = 'outcome';
  else if (wordPattern(config.processWords).test(text)) category = 'process';
  return { category, intent, attribution };
}

interface Candidate {
  block: PageBlock;
  quote: string;
}

function candidatesOf(structure: PageStructure, excluded: ExcludedBlock[], repeated: ReadonlySet<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const block of structure.blocks) {
    if (block.chrome) { excluded.push({ url: structure.url, text: block.text, reason: block.chrome }); continue; }
    if (block.isHeading || (block.region === 'table' && block.tableHeader)) { excluded.push({ url: structure.url, text: block.text, reason: 'heading' }); continue; }
    const pieces = block.region === 'table' ? [block.text] : sentencesOf(block.text);
    for (const piece of pieces) {
      const confirmedCell = block.region === 'table' && block.rowLabel !== '' && block.colLabel !== '';
      if (!confirmedCell && wordCount(piece) < 2 && !hasDigit(piece)) { excluded.push({ url: structure.url, text: piece, reason: 'too_short' }); continue; }
      if (!hasDigit(piece) && repeated.has(normalizeForQuote(piece))) { excluded.push({ url: structure.url, text: piece, reason: 'repeated_across_pages' }); continue; }
      out.push({ block, quote: piece });
    }
  }
  return out;
}

/** Sentences with no figure that appear on many pages: site furniture, not evidence. */
function repeatedTexts(structures: readonly PageStructure[], config: EvidenceConfig): Set<string> {
  const pagesOf = new Map<string, Set<string>>();
  for (const structure of structures) {
    for (const block of structure.blocks) {
      if (block.isHeading) continue;
      for (const piece of sentencesOf(block.text)) {
        const key = normalizeForQuote(piece);
        pagesOf.set(key, (pagesOf.get(key) ?? new Set()).add(structure.url));
      }
    }
  }
  return new Set([...pagesOf].filter(([, urls]) => urls.size >= config.repeatedAcrossPages).map(([key]) => key));
}

/** Card ids that belong to a real set of parallel cards: at least two sibling cards, at least two of which carry a figure (a price, a limit, a count). */
function planCards(structure: PageStructure): Set<string> {
  const figures = new Map<string, Set<string>>();
  for (const block of structure.blocks) {
    if (block.cardId === '' || block.isHeading || !hasDigit(block.text)) continue;
    figures.set(block.cardGroup, (figures.get(block.cardGroup) ?? new Set()).add(block.cardId));
  }
  const cards = new Set<string>();
  for (const block of structure.blocks) if (block.cardId !== '' && (figures.get(block.cardGroup)?.size ?? 0) >= 2) cards.add(block.cardId);
  return cards;
}

export function factsOfPage(structure: PageStructure, now: Date, config: EvidenceConfig, repeated: ReadonlySet<string>): { facts: EvidenceFact[]; excluded: ExcludedBlock[]; snapshot: PageSnapshot } {
  const excluded: ExcludedBlock[] = [];
  const text = structure.blocks.map((b) => b.text).join('\n');
  const contentHash = `sha256:${sha(normalizeForQuote(text))}`;
  const pageRole = pageRoleOf(structure.url, config);
  const snapshot: PageSnapshot = { url: structure.url, title: structure.title, pageRole, contentHash, text };
  const demoPattern = wordPattern(config.demoWords);
  const targetPattern = wordPattern(config.targetWords);
  const taxPattern = wordPattern(config.taxWords);
  const cards = planCards(structure);
  const facts: EvidenceFact[] = [];
  const seen = new Set<string>();

  for (const { block, quote } of candidatesOf(structure, excluded, repeated)) {
    const values = extractFacts(quote, config.claim);
    const hasNumbers = values.numbers.length > 0;
    const cell = block.region === 'table' && block.rowLabel !== '' && block.colLabel !== '';
    const inCard = block.cardTitle !== '' && cards.has(block.cardId);
    const scope = cell ? block.colLabel : inCard ? block.cardTitle : undefined;
    const label = cell ? block.rowLabel : undefined;
    const reasons: ReasonCode[] = [];

    const language = (block.lang || structure.lang || '').toLowerCase().split('-')[0] ?? '';
    if (language !== '' && !config.supportedLanguages.includes(language)) reasons.push('language_unsupported');
    const demo = block.demo || demoPattern.test(quote) || demoPattern.test(block.text);
    if (demo) reasons.push('demo_context');
    const target = hasNumbers && targetPattern.test(quote);
    if (target) reasons.push('target_not_guarantee');
    if (block.strip) reasons.push('stat_strip');
    if (!hasLetters(quote) && !cell && scope === undefined) reasons.push('bare_number');
    if (pageRole === 'case_study' && hasNumbers) reasons.push('customer_result');
    if (values.numbers.length >= 2) reasons.push('multi_claim');
    const fragment = wordCount(quote) < 4;
    if (taxPattern.test(quote) && scope === undefined) reasons.push('tax_scope_unconfirmed');
    else if (fragment && (hasNumbers || values.prices.length > 0) && scope === undefined) reasons.push('scope_unconfirmed');
    if (quote.length > config.maxSentenceChars) reasons.push('too_long');

    const key = `${normalizeForQuote(quote)}|${scope ?? ''}|${label ?? ''}`;
    if (seen.has(key)) { excluded.push({ url: structure.url, text: quote, reason: 'duplicate' }); continue; }
    seen.add(key);
    if (facts.length >= config.maxFactsPerPage) { excluded.push({ url: structure.url, text: quote, reason: 'page_cap' }); continue; }

    const { category, intent, attribution } = classify(quote, pageRole, hasNumbers, values.prices.length > 0, config, target, demo);
    const needsScope = fragment && (hasNumbers || values.prices.length > 0);
    const association: Association = scope !== undefined ? 'confirmed' : needsScope || taxPattern.test(quote) ? 'unknown' : 'confirmed';
    const context = [block.headingText, cell ? `${block.rowLabel} / ${block.colLabel}` : '', inCard ? block.cardTitle : ''].filter(Boolean).join(' > ');
    facts.push({
      id: sha(`${structure.url}|${scope ?? ''}|${label ?? ''}|${normalizeForQuote(quote)}`).slice(0, 12),
      category,
      text: quote,
      ...(scope !== undefined ? { scope } : {}),
      ...(label !== undefined ? { label } : {}),
      qualifiers: values.qualifiers.map((q) => q.split('|')[0] ?? q),
      source: { url: structure.url, contentHash, quote, context, heading: block.headingText, regionType: block.region, pageRole },
      associationStatus: association,
      attribution,
      intent,
      values: { numbers: values.numbers, prices: values.prices, currencies: values.currencies, periods: values.periods, units: values.units },
      language,
      status: reasons.length === 0 ? 'usable' : 'needs_review',
      reasonCodes: [...new Set(reasons)],
      capturedAt: now.toISOString(),
    });
  }
  return { facts, excluded, snapshot };
}

export interface EvidenceSet {
  facts: EvidenceFact[];
  excluded: ExcludedBlock[];
  snapshots: PageSnapshot[];
}

/** Facts of every page read, with site furniture (text repeated across pages) removed from the candidates and recorded as excluded. */
export function buildEvidence(structures: readonly PageStructure[], now: Date, options: Partial<EvidenceConfig> = {}): EvidenceSet {
  const config = { ...defaultEvidenceConfig, ...options };
  const repeated = repeatedTexts(structures, config);
  const set: EvidenceSet = { facts: [], excluded: [], snapshots: [] };
  for (const structure of structures) {
    const page = factsOfPage(structure, now, config, repeated);
    set.facts.push(...page.facts);
    set.excluded.push(...page.excluded);
    set.snapshots.push(page.snapshot);
  }
  return set;
}

/** The fact as one line for a person or a prompt: scope and label from the structure, then the exact words. */
export function displayFact(fact: EvidenceFact): string {
  const head = [fact.scope, fact.label].filter(Boolean).join(' · ');
  return head ? `${head}: ${fact.text}` : fact.text;
}

/** True when the quote is still on the page it was taken from, as the page reads now. */
export function quoteStillOnPage(fact: EvidenceFact, snapshots: readonly PageSnapshot[]): boolean {
  const page = snapshots.find((s) => s.url === fact.source.url);
  return page !== undefined && normalizeForQuote(page.text).includes(normalizeForQuote(fact.source.quote));
}

/** Facts as flat text only: no structure, so every fact is held for review. Used when Chrome could not read the page. */
export function flatTextEvidence(url: string, text: string, now: Date, options: Partial<EvidenceConfig> = {}): EvidenceSet {
  const config = { ...defaultEvidenceConfig, ...options };
  const structure: PageStructure = {
    url,
    title: '',
    lang: '',
    truncated: false,
    blocks: text.split(/\n+/).filter((line) => line.trim() !== '').map((line, i) => ({
      id: `f${i}`, text: line.trim(), tag: 'p', region: 'prose' as const, isHeading: false, headingText: '', chrome: '' as const, cardId: '', cardGroup: '', cardTitle: '', rowLabel: '', colLabel: '', tableHeader: false, demo: false, strip: false, lang: '',
    })),
  };
  const set = buildEvidence([structure], now, config);
  set.facts = set.facts.map((f) => ({ ...f, status: 'needs_review' as const, reasonCodes: [...new Set<ReasonCode>([...f.reasonCodes, 'flat_text_only'])] }));
  return set;
}
