/**
 * What a site must show before posters are made from it, checked from what was read and before anything is bought. Each failure is a stable code
 * with a plain reason, so the caller stops with fewer posters (down to none) instead of writing something the evidence does not support:
 *
 *   UNSUPPORTED_LANGUAGE   the site is demonstrably not in a language the engine reads, writes and checks (a stop), or only looks that way (a warning);
 *   BRAND_UNVERIFIED       the brand name is neither in the site's domain nor in the text read from it: a warning, and no picture is bought for the site;
 *   INSUFFICIENT_EVIDENCE  there is no fact the engine may use on its own (a stop).
 *
 * The language and name checks are heuristics, so on their own they only warn; they stop a run only when the evidence is plain.
 */

export type PreflightCode = 'UNSUPPORTED_LANGUAGE' | 'BRAND_UNVERIFIED' | 'INSUFFICIENT_EVIDENCE';

/** A finding: a "stop" ends the run, a "warn" is recorded and shown but lets the run go on (with fewer risks taken where the code says so). */
export interface PreflightFailure {
  code: PreflightCode;
  reason: string;
  severity: 'stop' | 'warn';
}

export class PreflightError extends Error {
  readonly code: PreflightCode;
  constructor(failure: PreflightFailure) {
    super(failure.reason);
    this.name = 'PreflightError';
    this.code = failure.code;
  }
}

export interface PreflightConfig {
  /** Language subtags the engine works in. */
  supportedLanguages: readonly string[];
  /** The fewest facts usable on their own that a run needs. */
  minUsableFacts: number;
  /** Words that are common in English text and rare elsewhere, used when a site declares no language. */
  stopWords: readonly string[];
  /** The share of a sample's words that must be stop words for it to read as English. */
  minStopWordShare: number;
  /** A sample with fewer distinct words than this is too short to judge by its words. */
  minWordsToJudge: number;
  /** The share of letters outside the Latin script above which a sample is not in a Latin-script language. */
  maxNonLatinShare: number;
  /** Above this share of non-Latin letters the site is plainly not in a Latin-script language, whatever it declares. */
  stopNonLatinShare: number;
  /** Below this stop-word share (with enough distinct words) the text plainly is not English. */
  stopStopWordShare: number;
}

export const defaultPreflightConfig: PreflightConfig = {
  supportedLanguages: ['en'],
  minUsableFacts: 1,
  stopWords: ['the', 'and', 'to', 'of', 'a', 'in', 'for', 'is', 'with', 'your', 'you', 'that', 'on', 'it', 'are', 'as', 'can', 'our', 'we', 'by', 'from', 'or', 'be', 'this', 'at', 'all', 'more'],
  minStopWordShare: 0.12,
  minWordsToJudge: 30,
  maxNonLatinShare: 0.25,
  stopNonLatinShare: 0.6,
  stopStopWordShare: 0.06,
};

const letters = (text: string): string[] => [...text].filter((c) => /\p{L}/u.test(c));

/**
 * Whether a sample of site text reads as a language the engine supports. `declared` is the language the site says it is in, as written ("en-GB"), if any.
 * Plain evidence stops the run (mostly non-Latin letters, or a foreign declared language that the text bears out); a mere impression only warns.
 */
export function checkLanguage(sample: string, declared: string | null | undefined, config: PreflightConfig = defaultPreflightConfig): PreflightFailure | undefined {
  const tag = (declared ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  const foreignDeclared = tag !== '' && !config.supportedLanguages.includes(tag);
  const all = letters(sample);
  const nonLatin = all.length === 0 ? 0 : all.filter((c) => !/\p{Script=Latin}/u.test(c)).length / all.length;
  const words = sample.toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
  // Repeated words (a page that says one thing many times) are not a sample of a language, so only the distinct words count towards having enough to judge.
  const judged = new Set(words).size >= config.minWordsToJudge;
  const stop = new Set(config.stopWords);
  const share = judged ? words.filter((w) => stop.has(w)).length / words.length : null;

  if (nonLatin > config.stopNonLatinShare) return { code: 'UNSUPPORTED_LANGUAGE', severity: 'stop', reason: `${Math.round(nonLatin * 100)}% of the site's letters are not Latin script, so it is not in a language the engine supports` };
  if (foreignDeclared && (nonLatin > config.maxNonLatinShare || (share !== null && share < config.minStopWordShare))) {
    return { code: 'UNSUPPORTED_LANGUAGE', severity: 'stop', reason: `the site declares its language as "${declared}" and its text bears that out; the engine does not write or check it yet (supported: ${config.supportedLanguages.join(', ')})` };
  }
  // Only running text can show that a language is not English: a menu of single words has no common words in any language.
  const prose = (sample.match(/[.!?](?:\s|$)/g) ?? []).length >= 3;
  if (share !== null && prose && share < config.stopStopWordShare) {
    return { code: 'UNSUPPORTED_LANGUAGE', severity: 'stop', reason: `the site's text is plainly not English (${Math.round(share * 100)}% common English words)` };
  }
  if (foreignDeclared) return { code: 'UNSUPPORTED_LANGUAGE', severity: 'warn', reason: `the site declares its language as "${declared}" but its text reads as English; it is treated as English` };
  if (nonLatin > config.maxNonLatinShare) return { code: 'UNSUPPORTED_LANGUAGE', severity: 'warn', reason: `${Math.round(nonLatin * 100)}% of the site's letters are not Latin script; check that the posters read correctly` };
  if (share !== null && share < config.minStopWordShare) return { code: 'UNSUPPORTED_LANGUAGE', severity: 'warn', reason: `the site's text may not be English (${Math.round(share * 100)}% common English words); check the posters` };
  return undefined;
}

const squash = (text: string): string => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The part of a host that names the business: "www.oyechats.com" gives "oyechats". */
export function domainLabel(site: string): string {
  let host = site;
  try {
    host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname;
  } catch {
    /* use the text as it is */
  }
  const labels = host.toLowerCase().replace(/^www\./, '').split('.');
  const country = labels.length >= 3 && labels.at(-2)!.length <= 3 && labels.at(-1)!.length === 2;
  return squash(labels.at(country ? -3 : -2) ?? labels[0] ?? '');
}

/** Whether the brand name, the site's domain and the text read from the site agree on who the business is. Disagreement is a warning that stops pictures being bought, not a stop. */
export function checkBrandIdentity(input: { name: string; site: string; pageText: string; titles?: readonly string[] }): PreflightFailure | undefined {
  const name = squash(input.name);
  const label = domainLabel(input.site);
  if (name === '') return { code: 'BRAND_UNVERIFIED', severity: 'warn', reason: 'the brand profile has no name' };
  if (label.length >= 3 && (name.includes(label) || (name.length >= 3 && label.includes(name)))) return undefined;
  // A name that is not in the domain (a short domain, a brand with a longer public name) must at least be what the site calls itself.
  const text = squash(`${input.titles?.join(' ') ?? ''} ${input.pageText}`);
  if (name.length >= 3 && text.includes(name)) return undefined;
  return { code: 'BRAND_UNVERIFIED', severity: 'warn', reason: `the brand name "${input.name}" is not in the site's domain (${label || input.site}) and does not appear in the text read from it, so the business could not be confirmed; no picture is bought for this site` };
}

/** Whether there is anything the engine may write about. */
export function checkEvidence(usableFacts: number, config: PreflightConfig = defaultPreflightConfig): PreflightFailure | undefined {
  if (usableFacts >= config.minUsableFacts) return undefined;
  return { code: 'INSUFFICIENT_EVIDENCE', severity: 'stop', reason: `the site gave ${usableFacts} fact${usableFacts === 1 ? '' : 's'} the engine may use on its own (it needs ${config.minUsableFacts}); no posters are made rather than inventing content` };
}
