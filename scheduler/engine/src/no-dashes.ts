/**
 * Words we write for a customer never carry a dash used as punctuation: no em dash (—) and no en dash (–) between words. A model told not to still slips one in now and then,
 * so every text we write is cleaned here before it is stored or shown. The writer's own instructions say the same (see NO_DASH_RULE).
 *
 * - A dash between two numbers (10–20, 2020—2024) becomes a plain hyphen: 10-20.
 * - A dash between words, with or without spaces, becomes a comma and a space: "fast — and simple" becomes "fast, and simple".
 * - A dash that ends a sentence or a line becomes a full stop.
 * A hyphen (-) is never changed. Only the writer's words are cleaned; words a customer typed herself are never passed through here.
 */
export const NO_DASH_RULE = 'Never use an em dash (—) or an en dash (–) as punctuation: write two sentences, or use a comma or a colon. A hyphen is fine inside a word or between numbers (for example 10-20).';

const DASH = /[—–―]/;
const RUN = /[ \t]*[—–―]+[ \t]*/g;

export function withoutDashes(text: string): string {
  if (!DASH.test(text)) return text;
  return text.replace(RUN, (match, offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + match.length);
    const prev = before.slice(-1);
    const next = after.slice(0, 1);
    if (/\d/.test(prev) && /\d/.test(next)) return '-';
    if (after === '' || next === '\n') return /[.!?,:;]$/.test(before) || before === '' ? '' : '.';
    if (before === '' || prev === '\n') return '';
    if (/[,;:]$/.test(before)) return ' ';
    if (/[.!?]$/.test(before)) return ' ';
    return ', ';
  });
}

/** The same cleaning for every string of a list, keeping the list. */
export const withoutDashesAll = <T extends string>(texts: readonly T[]): string[] => texts.map(withoutDashes);

/** A written post with its headline, subline and caption cleaned (hashtags and everything else as it is). */
export const cleanPost = <T extends { headline: string; subline?: string; caption: string }>(post: T): T => ({
  ...post,
  headline: withoutDashes(post.headline),
  ...(post.subline !== undefined ? { subline: withoutDashes(post.subline) } : {}),
  caption: withoutDashes(post.caption),
});

/** The captions of a post for each network, cleaned. */
export const cleanCaptions = <T extends { text: string }>(captions: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(captions).map(([network, c]) => [network, { ...c, text: withoutDashes(c.text) }]));
