/**
 * What a customer says herself about this week (a festival offer, a new dish, an event), kept as her own statement and turned into facts for the writer. It is not the website's
 * word, so it is never called verified: the facts carry the address `customer-statement:<id>` as their source, are shown as "from you", and the original text is kept as typed.
 * The claim gate then treats a fact like any other (a figure, price, date or qualifier in the copy must be the one she wrote). Her typing a claim is not proof of it, so claims that
 * need proof (a guarantee, a superlative, a certificate, a result, a customer count, a comparison) are refused up front, and she is told which words to change.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultClaimConfig, present } from './claims.ts';
import { flatTextEvidence, type EvidenceFact, type ReasonCode } from './evidence.ts';

export const CUSTOMER_FACTS_FILE = 'customer-facts.json';
export const MIN_TOPIC_CHARS = 10;
export const MAX_TOPIC_CHARS = 1000;
const KEEP_STATEMENTS = 200;

export interface CustomerStatement {
  id: string;
  /** Exactly as she typed it. */
  text: string;
  by: string;
  at: string;
}

export const statementUrl = (id: string): string => `customer-statement:${id}`;
export const isCustomerFact = (fact: Pick<EvidenceFact, 'source'>): boolean => fact.source.url.startsWith('customer-statement:');

/** Claims that need proof a customer's own typing cannot give: certificates and awards, results, medical and money promises, customer counts, comparisons. */
const NEEDS_PROOF: ReadonlyArray<[RegExp, string]> = [
  [/\b(certified|certification|accredited|iso\s?\d{3,5}|award[- ]winning|awarded|winner of)\b/i, 'a certificate or an award'],
  [/\b(clinically|proven|cure[sd]?|heals?|treats?|diagnos\w*|lose \d+ ?(kg|lbs|pounds)|weight loss)\b/i, 'a medical or a results claim'],
  [/\b(guaranteed returns?|risk[- ]free returns?|double your money|earn \d+)\b/i, 'a money promise'],
  [/\b\d[\d,.]*\+?\s*(happy\s+|satisfied\s+)?(customers|clients|patients|users|families)\b/i, 'a count of customers'],
  [/\b(better than|cheaper than|faster than|unlike (our )?competitors?|than (any )?(other|others|competitors?))\b/i, 'a comparison with others'],
];
/** A link in any of its forms: an address with a scheme, www., a bare domain (name.com, shop.in, ...) or an email address. */
const TLDS = 'com|in|co|org|net|io|app|shop|store|online|site|me|info|biz|dev|xyz|uk|us|ca|au|ae|sg|de|fr|tv|ly|link|page|food|cafe|menu';
const LINK = new RegExp(`https?:\\/\\/|www\\.[a-z0-9-]+\\.[a-z]{2,}|[^\\s@]+@[^\\s@]+\\.[a-z]{2,}|\\b[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})\\b(?![a-z0-9-])`, 'i');

/** A fixed code for why her text cannot be used, so a product can say it in its own words. */
export type TextProblemReason = 'NOT_TEXT' | 'TOO_SHORT' | 'TOO_LONG' | 'LINK_NOT_ALLOWED' | 'NEEDS_PROOF';
export interface TextProblem {
  reason: TextProblemReason;
  /** A plain sentence to show her. */
  message: string;
}

/** Why this text cannot be used as it is, as a code and a plain sentence; null when it can. */
export function customerTextProblem(value: unknown): TextProblem | null {
  if (typeof value !== 'string') return { reason: 'NOT_TEXT', message: 'Write what the post is about.' };
  const text = value.trim();
  if (text.length < MIN_TOPIC_CHARS) return { reason: 'TOO_SHORT', message: 'Write a little more: what is it, and when or for how long.' };
  if (text.length > MAX_TOPIC_CHARS) return { reason: 'TOO_LONG', message: `Keep it under ${MAX_TOPIC_CHARS} characters.` };
  if (LINK.test(text)) return { reason: 'LINK_NOT_ALLOWED', message: 'Links are not read in this box. Write the details in words, or add the page to the website first.' };
  const hold = present(defaultClaimConfig.guarantees, text)[0] ?? present(defaultClaimConfig.superlatives, text)[0];
  if (hold !== undefined) return { reason: 'NEEDS_PROOF', message: `"${hold.split('|')[0]}" is a claim that needs proof, so it cannot be used. Say it in plain words, for example what the offer includes.` };
  for (const [pattern, what] of NEEDS_PROOF) if (pattern.test(text)) return { reason: 'NEEDS_PROOF', message: `The text has ${what}, which needs proof. Take it out, or ask for it to be added from a page that states it.` };
  return null;
}

/** Why this text cannot be used as it is, in a plain sentence to show her; null when it can. */
export const checkCustomerText = (value: unknown): string | null => customerTextProblem(value)?.message ?? null;

/** The facts of one statement: each sentence of her text as a usable fact whose source is her statement. */
export function factsOfStatement(statement: CustomerStatement): EvidenceFact[] {
  const set = flatTextEvidence(statementUrl(statement.id), statement.text, new Date(statement.at));
  return set.facts.map((f): EvidenceFact => {
    const { proofHold: _hold, ...rest } = f;
    return {
      ...rest,
      status: 'usable',
      reasonCodes: f.reasonCodes.filter((c): c is ReasonCode => c !== 'flat_text_only'),
      capturedAt: statement.at,
      source: { ...f.source, context: 'Written by the customer', heading: '', pageRole: 'other' },
    };
  });
}

export function readStatements(brandDir: string): CustomerStatement[] {
  try {
    const raw = JSON.parse(readFileSync(join(brandDir, CUSTOMER_FACTS_FILE), 'utf8')) as { statements?: unknown };
    return Array.isArray(raw.statements) ? (raw.statements as CustomerStatement[]).filter((s) => typeof s?.id === 'string' && typeof s.text === 'string' && typeof s.at === 'string') : [];
  } catch {
    return [];
  }
}

/** Every fact of every statement she made, for the brand's fact list. */
export function customerFactsOf(brandDir: string): EvidenceFact[] {
  return readStatements(brandDir).flatMap(factsOfStatement);
}

/** Keeps her statement as typed. Refuses (returns null) text that has no sentence the writer could use. */
export function saveStatement(brandDir: string, statement: CustomerStatement): { facts: EvidenceFact[] } | null {
  const facts = factsOfStatement(statement);
  if (facts.length === 0) return null;
  const all = [...readStatements(brandDir).filter((s) => s.id !== statement.id), statement].slice(-KEEP_STATEMENTS);
  const file = join(brandDir, CUSTOMER_FACTS_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ statements: all }, null, 2)}\n`);
  renameSync(temp, file);
  return { facts };
}

/** The facts a topic post is written from: only those of its own statement (the rest of the brand's facts are not mixed in). */
export const factsForTopic = (facts: readonly EvidenceFact[], topicId: string): EvidenceFact[] => facts.filter((f) => f.source.url === statementUrl(topicId));
