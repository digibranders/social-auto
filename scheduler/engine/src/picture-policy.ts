/**
 * What a generated picture may not claim. The picture maker writes backgrounds and illustrations, not facts: figures,
 * logos, credentials, real product screens and real places are drawn by code from approved material or left out. The
 * policy is a list of categories, each with the words that suggest a request in that category and, where an approved
 * asset or verified evidence makes it legitimate, what lifts it. It is generic: no category names an industry. A word
 * match is a signal to hold the brief back, never proof of a problem; the words are settings and the category names are
 * what a reviewer sees.
 */

export interface PolicyCategory {
  id: string;
  terms: readonly string[];
  /** Digits and percent signs also count as a request in this category. */
  numbers?: boolean;
  /** When this approved material exists for the post, the category is allowed. */
  unless?: 'productAsset' | 'credential';
}

export const defaultPicturePolicy: readonly PolicyCategory[] = [
  { id: 'baked_in_text', terms: ['text', 'letters', 'lettering', 'typography', 'caption', 'headline', 'slogan', 'words', 'handwriting', 'writing'] },
  { id: 'numbers_and_metrics', terms: ['price tag', 'percentage', 'percent', 'statistic', 'statistics', 'chart values', 'metric', 'metrics'], numbers: true },
  { id: 'logos_and_marks', terms: ['logo', 'logos', 'logotype', 'wordmark', 'trademark', 'brand mark', 'emblem'] },
  { id: 'credentials_and_awards', terms: ['award', 'awards', 'trophy', 'medal', 'certificate', 'certified', 'accredited', 'badge', 'seal of approval', 'star rating', 'five star', 'ranked'], unless: 'credential' },
  { id: 'product_interface', terms: ['screenshot', 'screen capture', 'user interface', 'ui', 'interface mockup', 'app screen'], unless: 'productAsset' },
  { id: 'real_places_and_people', terms: ['our office', 'our store', 'our shop', 'our building', 'our team', 'our staff', 'storefront', 'headquarters', 'actual location', 'real location'] },
];

export interface PolicyApprovals {
  productAsset?: boolean;
  credential?: boolean;
}

export interface PolicyResult {
  /** Category ids the text asks for without approved material. */
  violations: string[];
  /** Checks that could not be applied, such as a script the word lists do not cover. */
  warnings: string[];
}

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalise = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}%\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
const hasWord = (text: string, term: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${escape(term)}(?![\\p{L}\\p{N}])`, 'u').test(text);
const isNonLatin = (text: string): boolean => [...text].some((c) => /\p{L}/u.test(c) && !/\p{Script=Latin}/u.test(c));

/** Checks the picture text a model wrote (scene, composition, mood) against the policy. Subject and action come from the accepted concept and are not rewritten here. */
export function checkPicturePolicy(fields: readonly string[], approvals: PolicyApprovals = {}, policy: readonly PolicyCategory[] = defaultPicturePolicy): PolicyResult {
  const text = normalise(fields.join(' . '));
  const violations: string[] = [];
  for (const category of policy) {
    if (category.unless === 'productAsset' && approvals.productAsset) continue;
    if (category.unless === 'credential' && approvals.credential) continue;
    const asked = category.terms.some((term) => hasWord(text, normalise(term))) || (category.numbers === true && /[\p{N}%]/u.test(text));
    if (asked) violations.push(category.id);
  }
  const warnings = isNonLatin(text) ? ['unsupported_language: the word lists of the picture policy were not applied to non-Latin text'] : [];
  return { violations, warnings };
}
