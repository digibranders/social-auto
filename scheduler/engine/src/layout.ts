import { escapeHtml, LAYOUTS, parseHeadline, type Brand, type FeatureIcon, type LayoutName, type PlannedPost } from './content.ts';

export const CANVAS_SIZE = 1080;

export interface LayoutInput {
  brand: Brand;
  post: PlannedPost;
  /** 1-based position of the post in the plan, shown as "Pain point #N". */
  painPointNumber: number;
  /** Logo markup: inline <svg> or an <img> pointing at a local file. */
  logoHtml: string;
  /** file:// URL of the AI visual; omitted for text-only posters. */
  visualUrl?: string;
}

const ICONS: Record<FeatureIcon, string> = {
  monitor:
    '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  gear:
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  person: '<circle cx="12" cy="12" r="9.5"/><circle cx="12" cy="10" r="3.2"/><path d="M6.5 18.2c1.3-2.2 3.3-3.3 5.5-3.3s4.2 1.1 5.5 3.3"/>',
  shield: '<path d="M12 2.8l7.5 3v5.7c0 4.6-3.2 8.3-7.5 9.7-4.3-1.4-7.5-5.1-7.5-9.7V5.8z"/><path d="M8.7 12.2l2.3 2.3 4.4-4.6"/>',
};

/**
 * The layout of the post at `index` (0-based) in the plan for week `weekNumber`. Neighbouring posts always
 * differ, including across the end of one week and the start of the next, and every layout appears in a week.
 */
export function layoutFor(weekNumber: number, index: number): LayoutName {
  return LAYOUTS[(index + weekNumber * 3) % LAYOUTS.length] as LayoutName;
}

/** A mild hint about where the text of this layout goes, for picture models that can follow it. */
export function compositionFor(layout: LayoutName): string {
  switch (layout) {
    case 'left':
      return 'composed with the subject on the right side and open, uncluttered space on the left side';
    case 'right':
      return 'composed with the subject on the left side and open, uncluttered space on the right side';
    case 'bottom':
      return 'composed with the subject in the upper part and open, uncluttered space in the lower part';
    case 'dark':
      return 'composed with the subject in the upper part and softer, darker space in the lower part';
  }
}

/**
 * Appended to every scene prompt: lighting, style and the no-text rule. Where the subject sits is left to the
 * picture model unless `withComposition` is set, so the prompt is not tuned to one model's habits.
 */
export function visualStyleFor(layout: LayoutName, withComposition = false): string {
  const light = layout === 'dark' ? 'moody warm natural light' : 'bright warm natural light';
  const hint = withComposition ? `, ${compositionFor(layout)}` : '';
  return `${hint}, ${light}, premium commercial advertising photography, realistic, shallow depth of field, absolutely no text, no letters, no words, no logos anywhere`;
}

/** Lightens a #RRGGBB colour by the given fraction towards white (used for accents on dark backgrounds). */
export function lighten(hex: string, amount: number): string {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `#${channels
    .map((c) => Math.round(c + (255 - c) * amount).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Darkens a #RRGGBB colour by the given fraction for readable text on light backgrounds. */
export function darken(hex: string, amount: number): string {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `#${channels
    .map((c) => Math.round(c * (1 - amount)).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Larger type for short headlines; long ones step down so they stay within the left column. */
export function headlineFontSize(post: PlannedPost): number {
  const length = parseHeadline(post.headline).reduce((sum, s) => sum + s.text.trim().length, 0);
  if (length <= 28) return 84;
  if (length <= 40) return 74;
  if (length <= 52) return 64;
  return 56;
}

function headlineHtml(post: PlannedPost): string {
  return parseHeadline(post.headline)
    .map((s) => (s.accent ? `<span class="accent">${escapeHtml(s.text)}</span>` : escapeHtml(s.text)))
    .join('');
}

function fontLink(font: string): string {
  const family = encodeURIComponent(font).replaceAll('%20', '+');
  return `https://fonts.googleapis.com/css2?family=${family}:wght@400;500;700;800;900&display=block`;
}

/** Rules that turn the base ("left") poster into another layout; the base styles stay the same for all. */
function layoutCss(layout: LayoutName, colors: Brand['colors'], cream: string): string {
  const fade = (direction: string): string =>
    `linear-gradient(${direction}, ${cream} 0%, ${cream}F2 38%, ${cream}99 54%, ${cream}00 68%)`;
  switch (layout) {
    case 'left':
      return '';
    case 'right':
      return `
  .layout-right .wash { background: ${fade('270deg')}; }
  .layout-right .logo { left: auto; right: 64px; }
  .layout-right .copy { left: auto; right: 64px; }`;
    case 'bottom':
      return `
  .layout-bottom .wash { background: linear-gradient(180deg, ${cream}00 0%, ${cream}00 34%, ${cream}99 46%, ${cream}F2 58%, ${cream} 70%); }
  .layout-bottom .logo { top: 44px; left: 52px; height: auto; padding: 12px 20px; border-radius: 16px; background: ${cream}E6; }
  .layout-bottom .copy { top: auto; bottom: 200px; width: 952px; }
  .layout-bottom p.sub { max-width: 780px; }`;
    case 'dark': {
      const ink = colors.ink;
      const accent = lighten(colors.accent, 0.3);
      return `
  .layout-dark { background-color: ${ink}; }
  .layout-dark .wash { background: linear-gradient(180deg, ${ink}1A 0%, ${ink}4D 30%, ${ink}D9 62%, ${ink}F2 100%); }
  .layout-dark .logo { top: 44px; left: 52px; height: auto; padding: 12px 20px; border-radius: 16px; background: ${cream}; }
  .layout-dark .copy { top: auto; bottom: 200px; width: 952px; }
  .layout-dark h1 { color: #fff; }
  .layout-dark h1 .accent { color: ${accent}; }
  .layout-dark p.sub { color: #E9E4DA; max-width: 780px; }
  .layout-dark .pill { background: rgba(255,255,255,0.12); border-color: ${accent}; color: #fff; }
  .layout-dark .swoosh path { stroke: ${accent}; }
  .layout-dark .bar { background: rgba(18,18,22,0.78); border-top-color: rgba(255,255,255,0.14); }
  .layout-dark .feature b { color: #fff; }
  .layout-dark .feature span { color: #CFCAC0; }
  .layout-dark .feature .icon { stroke: ${accent}; }`;
    }
  }
}

export function renderPostHtml({ brand, post, painPointNumber, logoHtml, visualUrl }: LayoutInput): string {
  const { colors } = brand;
  const accentText = darken(colors.accent, 0.22);
  const cream = '#F7F1E8';
  const layout = post.layout ?? 'left';
  const visual = visualUrl ? `url("${visualUrl}") center / cover no-repeat,` : '';

  const features = brand.features
    .map(
      (f) => `<div class="feature">
      <svg viewBox="0 0 24 24" class="icon">${ICONS[f.icon]}</svg>
      <div><b>${escapeHtml(f.title)}</b><span>${escapeHtml(f.detail)}</span></div>
    </div>`,
    )
    .join('<div class="divider"></div>');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${fontLink(brand.font)}">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${CANVAS_SIZE}px; height: ${CANVAS_SIZE}px; overflow: hidden; }
  body {
    font-family: '${brand.font}', system-ui, sans-serif;
    color: ${colors.ink};
    background: ${visual} ${cream};
    position: relative;
  }
  .wash {
    position: absolute; inset: 0;
    background: linear-gradient(90deg, ${cream} 0%, ${cream}F2 38%, ${cream}99 54%, ${cream}00 68%);
  }
  .logo { position: absolute; left: 64px; top: 58px; height: 62px; }
  .logo svg, .logo img { height: 62px; width: auto; max-width: 420px; object-fit: contain; display: block; }
  .copy { position: absolute; left: 64px; top: 172px; width: 560px; }
  .pill {
    display: inline-block; padding: 10px 26px; border-radius: 999px;
    border: 2.5px solid ${colors.accent}; background: #F3E2CC;
    color: ${accentText}; font-weight: 700; font-size: 25px; letter-spacing: 0.12em; text-transform: uppercase;
  }
  h1 {
    margin-top: 30px; font-weight: 900; font-size: ${headlineFontSize(post)}px;
    line-height: 1.04; letter-spacing: -0.025em;
  }
  h1 .accent { color: ${accentText}; }
  .swoosh { display: block; margin: 18px 0 0 4px; width: 190px; height: 26px; }
  p.sub { margin-top: 22px; font-size: 32px; font-weight: 500; line-height: 1.3; color: #2E2F35; max-width: 500px; }
  .bar {
    position: absolute; left: 0; right: 0; bottom: 0; height: 168px;
    background: rgba(255,255,255,0.9); border-top: 1px solid #E7DCCB;
    display: flex; align-items: center; justify-content: space-between; padding: 0 56px;
  }
  .feature { display: flex; align-items: center; gap: 18px; flex: 1; }
  .feature .icon {
    width: 62px; height: 62px; flex: none; fill: none; stroke: ${accentText};
    stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
  }
  .feature b { display: block; font-size: 25px; font-weight: 800; line-height: 1.15; }
  .feature span { display: block; font-size: 21px; color: #4A4B52; margin-top: 4px; }
  .divider { width: 2px; height: 86px; background: ${colors.accent}; opacity: 0.45; margin: 0 26px; }${layoutCss(layout, colors, cream)}
</style></head>
<body class="layout-${layout}">
  <div class="wash"></div>
  <div class="logo">${logoHtml}</div>
  <div class="copy">
    <div class="pill">Pain point #${painPointNumber}</div>
    <h1>${headlineHtml(post)}</h1>
    <svg class="swoosh" viewBox="0 0 190 26"><path d="M4 18 C 50 6, 120 4, 186 12" fill="none" stroke="${colors.accent}" stroke-width="6" stroke-linecap="round"/></svg>
    <p class="sub">${escapeHtml(post.subline)}</p>
  </div>
  <div class="bar">${features}</div>
</body></html>`;
}
