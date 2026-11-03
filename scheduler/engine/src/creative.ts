/**
 * The creative formats of a poster: which one a post gets, the prompt for its picture, and its layout. A type-only
 * poster has no picture; the others place the headline to suit their picture. None of them repeats the pain-point pill or
 * the service bar of the original photo poster.
 */
import { escapeHtml, FORMATS, parseHeadline, type Brand, type FormatName, type PlannedPost } from './content.ts';
import { CANVAS_SIZE, darken, fontLink, lighten, luminance, washColor, type LayoutInput } from './layout.ts';
import { plateFor } from './logo-tone.ts';

/** The plate behind a pale logo. */
const DARK_PLATE = '#14161C';

/**
 * The format of the post at `index` (0-based) in the plan for week `weekNumber`. Neighbouring posts always differ, including
 * across the end of one week and the start of the next, and every format appears in a week of seven.
 */
export function formatFor(weekNumber: number, index: number): FormatName {
  return FORMATS[(index + weekNumber * 3) % FORMATS.length] as FormatName;
}

type PictureFormat = Exclude<FormatName, 'type'>;

const STYLES: Record<PictureFormat, { look: string; room: string }> = {
  illustration: {
    look: 'Flat geometric vector illustration, bold simple shapes, subtle grain, editorial poster style',
    // The poster shows only the middle band of the picture (a wide strip), so the subject must sit in the middle of the square.
    room: 'the subject centered both ways and filling most of the width, with nothing important near the top and bottom edges',
  },
  'still-life': {
    look: 'Minimal studio still life of a single object on a seamless backdrop, dramatic rim light, soft haze, cinematic product photography',
    room: 'the subject in the upper right with large empty dark space on the left and the bottom',
  },
  isometric: {
    look: 'Isometric 3D render, clean soft studio lighting, subtle depth, modern tech brand illustration',
    room: 'empty space at the top left',
  },
};

/**
 * The prompt for a post's picture: the idea as an object or abstract scene, the format's look, the brand's own colours and
 * the no-text rule. The brand profile's style line is not used: it describes the old photo posters and asks for people.
 */
export function creativePrompt(format: PictureFormat, visual: string, brand: Pick<Brand, 'colors'>): string {
  const { look, room } = STYLES[format];
  const idea = visual.trim().replace(/\.$/, '');
  const { ink, accent } = brand.colors;
  return `${look}: ${idea}. Palette: deep ${ink} as the main colour with ${accent} as the single bright highlight, plus off-white. Composition: ${room}. No people, no faces, no hands, no text, no letters, no words, no logos anywhere`;
}

function headlineHtml(post: PlannedPost): string {
  return parseHeadline(post.headline)
    .map((s) => (s.accent ? `<span class="accent">${escapeHtml(s.text)}</span>` : escapeHtml(s.text)))
    .join('');
}

function headlineSize(post: PlannedPost, sizes: readonly [number, number, number, number]): number {
  const length = parseHeadline(post.headline).reduce((sum, s) => sum + s.text.trim().length, 0);
  return length <= 28 ? sizes[0] : length <= 40 ? sizes[1] : length <= 52 ? sizes[2] : sizes[3];
}

/** A colour that reads on a dark poster: the brand's accent, lightened when it is itself dark. */
const onDark = (accent: string): string => (luminance(accent) > 0.35 ? accent : lighten(accent, 0.4));

export function renderCreativePostHtml({ brand, post, logoHtml, visualUrl, logoTone }: LayoutInput): string {
  const format = post.format ?? 'type';
  const { colors } = brand;
  const dark = luminance(colors.ink) < 0.25 ? colors.ink : '#0F1722';
  const cream = washColor(colors.background);
  const accent = onDark(colors.accent);
  const plate = plateFor(logoTone ?? null, cream, DARK_PLATE);
  // A pale logo on the flat dark of a type-only poster needs no plate; over a picture, or if dark, it does.
  const logoBox =
    format === 'type' && plate === DARK_PLATE
      ? 'background: none;'
      : `padding: 12px 20px; border-radius: 16px; background: ${plate};${plate === DARK_PLATE ? ' box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.16);' : ''}`;
  const picture = format !== 'type' && visualUrl ? `url("${visualUrl}") center / cover no-repeat` : 'none';
  const size = (sizes: readonly [number, number, number, number]): number => headlineSize(post, sizes);

  const layouts: Record<FormatName, string> = {
    type: `
  body { background: ${dark}; color: #fff; }
  .logo { left: 72px; top: 64px; }
  h1 { position: absolute; left: 72px; right: 72px; top: 236px; font-size: ${size([152, 132, 112, 96])}px; line-height: 0.98; font-weight: 900; letter-spacing: -0.04em; }
  h1 .accent { color: ${accent}; }
  p.sub { position: absolute; left: 72px; right: 160px; bottom: 76px; font-size: 36px; line-height: 1.3; color: #C9D3DD; font-weight: 500; }
  .dot { position: absolute; right: 72px; bottom: 72px; width: 28px; height: 28px; border-radius: 50%; background: ${accent}; }`,
    illustration: `
  body { background: ${cream}; }
  .art { position: absolute; left: 0; right: 0; top: 0; height: 660px; background: ${picture}, ${dark}; }
  .logo { left: 52px; top: 44px; }
  .panel { position: absolute; left: 0; right: 0; bottom: 0; height: 420px; background: ${cream}; border-top: 10px solid ${colors.accent}; padding: 48px 64px 0; }
  h1 { font-size: ${size([92, 82, 74, 66])}px; line-height: 1.02; font-weight: 900; letter-spacing: -0.03em; color: ${colors.ink}; }
  h1 .accent { color: ${darken(colors.accent, 0.22)}; }
  p.sub { margin-top: 20px; font-size: 32px; line-height: 1.3; color: #4A4B52; font-weight: 500; max-width: 820px; }`,
    'still-life': `
  body { background: ${dark}; color: #fff; }
  .art { position: absolute; inset: 0; background: ${picture}, ${dark}; }
  .shade { position: absolute; inset: 0; background: linear-gradient(0deg, ${dark}F2 0%, ${dark}A6 34%, ${dark}00 64%); }
  .logo { left: 64px; top: 58px; }
  .stack { position: absolute; left: 64px; width: 800px; bottom: 64px; }
  h1 { font-size: ${size([104, 92, 82, 72])}px; line-height: 1; font-weight: 900; letter-spacing: -0.035em; }
  h1 .accent { color: ${accent}; }
  p.sub { margin-top: 24px; font-size: 32px; line-height: 1.3; color: #D6DDE4; font-weight: 500; }`,
    isometric: `
  body { background: ${dark}; color: #fff; }
  .art { position: absolute; inset: 0; background: ${picture}, ${dark}; }
  .shade { position: absolute; inset: 0; background: linear-gradient(135deg, ${dark}E6 0%, ${dark}99 34%, ${dark}00 62%); }
  .logo { right: 64px; top: 58px; }
  h1 { position: absolute; left: 64px; top: 140px; width: 600px; font-size: ${size([92, 82, 74, 66])}px; line-height: 1.02; font-weight: 900; letter-spacing: -0.03em; }
  h1 .accent { color: ${accent}; }
  p.sub { position: absolute; left: 64px; bottom: 64px; max-width: 760px; background: ${accent}; color: ${dark}; font-weight: 800; font-size: 30px; line-height: 1.25; padding: 16px 30px; border-radius: 30px; }`,
  };

  const copy =
    format === 'illustration'
      ? `<div class="panel"><h1>${headlineHtml(post)}</h1><p class="sub">${escapeHtml(post.subline)}</p></div>`
      : format === 'still-life'
        ? `<div class="stack"><h1>${headlineHtml(post)}</h1><p class="sub">${escapeHtml(post.subline)}</p></div>`
        : `<h1>${headlineHtml(post)}</h1><p class="sub">${escapeHtml(post.subline)}</p>${format === 'type' ? '<div class="dot"></div>' : ''}`;
  const picturePieces = format === 'illustration' ? '<div class="art"></div>' : format === 'type' ? '' : '<div class="art"></div><div class="shade"></div>';

  return `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${fontLink(brand.font)}">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${CANVAS_SIZE}px; height: ${CANVAS_SIZE}px; overflow: hidden; }
  body { font-family: '${brand.font}', system-ui, sans-serif; position: relative; }
  .logo { position: absolute; ${logoBox} }
  .logo svg, .logo img { height: 54px; width: auto; max-width: 420px; object-fit: contain; display: block; }${layouts[format]}
</style></head>
<body class="format-${format}">
  ${picturePieces}
  <div class="logo">${logoHtml}</div>
  ${copy}
</body></html>`;
}
