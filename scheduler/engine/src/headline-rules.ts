/**
 * Rules for a headline that belong to the copy stage, not to the picture. A poster names its brand in a separate sign-off, so a headline is a
 * message and not a label: it does not begin "Brand: ..." and does not repeat the name just to say who is speaking. And a headline is seen
 * without its caption, so a quantity that belongs to a plan keeps the plan in the headline.
 */
import { normalizeForQuote } from './claims.ts';
import type { EvidenceFact } from './evidence.ts';

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plainHeadline = (headline: string): string => headline.replace(/\|/g, '').replace(/\s+/g, ' ').trim();

/**
 * A headline that opens with the brand name used as a label: the name (with at most a short plan or product word after it) followed by a colon or a
 * dash, as in "Acme: five projects" or "Acme Advanced: unlimited members". A headline where the name is a natural part of the sentence is not touched.
 */
export function brandPrefixProblem(headline: string, brandName: string): string | undefined {
  const name = brandName.trim();
  if (name === '') return undefined;
  const text = plainHeadline(headline).normalize('NFKC');
  const label = new RegExp(`^${escapeRegex(name)}(?:\\s+[\\p{L}\\p{N}-]{1,20}){0,2}\\s*[:\\u2014\\u2013-]\\s`, 'iu');
  if (!label.test(text)) return undefined;
  return `the headline begins with the brand name as a label ("${text.slice(0, 40)}"); the brand is shown separately, so write the headline as a standalone message and do not start it with "${name}:"`;
}

const words = (text: string): string[] => normalizeForQuote(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * A figure or "unlimited" in the headline that belongs to a plan, card or table column of a fact, without that plan named in the headline. The figure
 * of one plan reads as a promise of the whole product when the plan is left out. Applies to the headline itself, because the poster is seen without its caption.
 */
export function planQualifierProblem(headline: string, facts: readonly EvidenceFact[]): string | undefined {
  const said = words(plainHeadline(headline));
  for (const fact of facts) {
    if (!fact.scope) continue;
    const figures = [...fact.values.numbers, ...(/(?<![\p{L}])unlimited(?![\p{L}])/iu.test(fact.text) ? ['unlimited'] : [])];
    const used = figures.filter((f) => said.includes(f.replace(/%$/, '')) || said.includes(f));
    if (used.length === 0) continue;
    const scopeWords = words(fact.scope).filter((w) => w.length >= 3);
    if (scopeWords.length === 0 || scopeWords.some((w) => said.includes(w))) continue;
    return `the headline states "${used[0]}" without its plan "${fact.scope}", which makes it read as a promise of the whole product; name the plan in the headline ("${fact.scope}") or leave the figure out`;
  }
  return undefined;
}
