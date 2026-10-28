import { escapeHtml, parseHeadline, type Brand, type FeatureIcon, type PlannedPost } from './content.ts';

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

export function renderPostHtml({ brand, post, painPointNumber, logoHtml, visualUrl }: LayoutInput): string {
  const { colors } = brand;
  const accentText = darken(colors.accent, 0.22);
  const cream = '#F7F1E8';
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
    background: linear-gradient(90deg, ${cream} 0%, ${cream}F2 34%, ${cream}99 50%, ${cream}00 64%);
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
  .divider { width: 2px; height: 86px; background: ${colors.accent}; opacity: 0.45; margin: 0 26px; }
</style></head>
<body>
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
