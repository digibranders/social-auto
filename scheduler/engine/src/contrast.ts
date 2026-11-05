/**
 * Contrast arithmetic for posters: WCAG ratios, alpha compositing, and how opaque a backing must be for text to stay
 * readable over the worst picture it could sit on. Colours are #RRGGBB.
 */
import { luminance } from './layout.ts';

/** The ratio posters aim for. WCAG allows 3:1 for large text, but 4.5:1 is the stricter default for social graphics. */
export const TARGET_RATIO = 4.5;

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour of `fg` laid over `bg` at the given opacity. */
export function composite(fg: string, alpha: number, bg: string): string {
  const channels = [1, 3, 5].map((i) => {
    const f = Number.parseInt(fg.slice(i, i + 2), 16);
    const b = Number.parseInt(bg.slice(i, i + 2), 16);
    return Math.round(f * alpha + b * (1 - alpha));
  });
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The smallest opacity (in steps of 0.05) at which `backing` makes `text` meet `target` over every background in `worst`
 * (the lightest and darkest picture it could sit on), or null when even a solid backing cannot.
 */
export function backingAlpha(text: string, backing: string, worst: readonly string[] = ['#FFFFFF', '#000000'], target: number = TARGET_RATIO): number | null {
  for (let step = 7; step <= 20; step++) {
    const alpha = step / 20;
    if (worst.every((bg) => contrastRatio(text, composite(backing, alpha, bg)) >= target)) return alpha;
  }
  return null;
}
