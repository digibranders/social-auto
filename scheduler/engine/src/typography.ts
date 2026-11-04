/**
 * Typography rules for posters: how large each kind of text may be, which script a text is written in, and the
 * line height, direction and font stack that suits it. Sizes are ranges: the renderer measures in a real browser and
 * takes the largest size inside the range that fits. Nothing here truncates text.
 */
import type { HeadlineScale } from './art-brief.ts';
import type { LayoutFamily } from './layout-registry.ts';

/** The largest headline size each scale allows; the family's own minimum is the floor. */
export const SCALE_MAX_PX: Readonly<Record<HeadlineScale, number>> = { xl: 160, large: 124, medium: 96, small: 72 };

export type TextRole = 'headline' | 'subline' | 'list' | 'figure' | 'quote' | 'offer' | 'identity' | 'cta' | 'brand';

/** Size ranges by role, in pixels on the 1080 canvas. A headline's floor comes from its family. */
export const ROLE_RANGE: Readonly<Record<Exclude<TextRole, 'headline'>, { max: number; min: number; maxLines: number }>> = {
  subline: { max: 36, min: 26, maxLines: 3 },
  list: { max: 40, min: 28, maxLines: 0 },
  figure: { max: 260, min: 120, maxLines: 1 },
  quote: { max: 72, min: 36, maxLines: 4 },
  offer: { max: 92, min: 40, maxLines: 3 },
  identity: { max: 28, min: 22, maxLines: 2 },
  cta: { max: 28, min: 22, maxLines: 1 },
  brand: { max: 34, min: 24, maxLines: 1 },
};

export function headlineRange(family: Pick<LayoutFamily, 'textConstraints'>, scale: HeadlineScale): { max: number; min: number; maxLines: number } {
  const min = family.textConstraints.minFontSize;
  return { max: Math.max(SCALE_MAX_PX[scale], min), min, maxLines: family.textConstraints.maxLines };
}

export type Script = 'latin' | 'devanagari' | 'arabic' | 'hebrew' | 'cjk' | 'other';

/** The dominant script among the letters of a text. */
export function scriptOf(text: string): Script {
  const counts: Record<Script, number> = { latin: 0, devanagari: 0, arabic: 0, hebrew: 0, cjk: 0, other: 0 };
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) counts.latin++;
    else if (/\p{Script=Devanagari}/u.test(ch)) counts.devanagari++;
    else if (/\p{Script=Arabic}/u.test(ch)) counts.arabic++;
    else if (/\p{Script=Hebrew}/u.test(ch)) counts.hebrew++;
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u.test(ch)) counts.cjk++;
    else counts.other++;
  }
  const [script, count] = (Object.entries(counts) as [Script, number][]).sort((a, b) => b[1] - a[1])[0] as [Script, number];
  return count === 0 ? 'latin' : script;
}

export interface TextStyle {
  script: Script;
  dir: 'ltr' | 'rtl';
  lineHeight: number;
  letterSpacingEm: number;
}

/** Line height, spacing and direction by script: tight, slightly negative spacing for Latin display type; looser and unspaced for complex scripts. */
export function textStyleFor(text: string, display: boolean): TextStyle {
  const script = scriptOf(text);
  const dir = script === 'arabic' || script === 'hebrew' ? 'rtl' : 'ltr';
  if (script === 'latin') return { script, dir, lineHeight: display ? 1.02 : 1.3, letterSpacingEm: display ? -0.03 : 0 };
  if (script === 'cjk') return { script, dir, lineHeight: display ? 1.2 : 1.45, letterSpacingEm: 0 };
  return { script, dir, lineHeight: display ? 1.3 : 1.5, letterSpacingEm: 0 };
}

/** A font ready to be named in CSS: the @font-face rules that load it (none for system fonts), the family stack, where it came from and which faces to expect loaded. */
export interface ResolvedFont {
  css: string;
  stack: string;
  source: 'local' | 'system';
  faces: string[];
}

const SYSTEM_STACK = '-apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Noto Sans Devanagari", "Noto Naskh Arabic", sans-serif';

/** No font file is bundled: the brand's font name is tried first, then common system fonts, and the render report says the source is "system". */
export function systemFont(name: string): ResolvedFont {
  const safe = name.replace(/["'\\<>{};]/g, '').trim();
  return { css: '', stack: safe ? `"${safe}", ${SYSTEM_STACK}` : SYSTEM_STACK, source: 'system', faces: [] };
}
