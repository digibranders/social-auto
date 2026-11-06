/**
 * How a poster will be branded, decided from what was captured on the client's site and settled BEFORE any picture is bought.
 *
 * Three intended outcomes: the site's own logo (`authentic_logo`), the plain brand name and web address (`text_only_fallback`, when no logo can be trusted and the
 * client has not asked for a real logo), or a stop (`logo_required_unavailable`, when the client requires a real logo and none can be trusted). What was
 * intended is kept apart from what was delivered: until the code that places the real logo on a finished poster exists (`compositorReady`), a trusted logo is
 * recorded as intended but not applied, and a client that requires a real logo is stopped rather than given a poster without one. Nothing here ever draws,
 * redraws or approximates a logo: the file is checked, hashed and, when it is used, copied as it is.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Brand, LogoKind } from './content.ts';

/** Whether the code that places a real logo on a finished poster exists and is switched on. It is not built yet: while false, no poster carries the real logo and a client that requires one is stopped. */
export const COMPOSITOR_READY = false;

export type BrandingIntent = 'authentic_logo' | 'text_only_fallback' | 'logo_required_unavailable';
export type BrandingApplied = 'text_only' | 'authentic_logo' | 'none';
/** `awaiting_compositor`: a trusted logo exists but the poster is made without it for now. `applied`: the finished poster really carries it. */
export type BrandingStatus = 'resolved' | 'awaiting_compositor' | 'applied' | 'blocked';

/** Why a logo was not used, one code for each reason so the owner is told the real one. */
export const BRANDING_REASONS = [
  'NO_LOGO_FOUND',
  'ONLY_NAME_AVAILABLE',
  'FILE_UNREADABLE',
  'UNSUPPORTED_FILE_TYPE',
  'FILE_TOO_LARGE',
  'UNSAFE_SVG',
  'INSUFFICIENT_RESOLUTION',
  'PLACEHOLDER_ASSET',
  'BAD_PROPORTIONS',
  'UNVERIFIED_PROVENANCE',
  'ICON_NOT_CONFIRMED',
  'LOGO_COMPOSITOR_UNAVAILABLE',
] as const;
export type BrandingReason = (typeof BRANDING_REASONS)[number];

/** The words the Review tab shows for each reason. */
export const BRANDING_REASON_TEXT: Readonly<Record<BrandingReason, string>> = {
  NO_LOGO_FOUND: 'No logo was found on the website.',
  ONLY_NAME_AVAILABLE: 'The website has no logo picture, only the name.',
  FILE_UNREADABLE: 'The saved logo file could not be read.',
  UNSUPPORTED_FILE_TYPE: 'The logo file is not a picture type that can be used (PNG, JPG, WebP or SVG).',
  FILE_TOO_LARGE: 'The logo file is too large to trust.',
  UNSAFE_SVG: 'The logo is an SVG that contains scripts or links to other files, so it is not used.',
  INSUFFICIENT_RESOLUTION: 'The logo picture is too small to look sharp on a poster.',
  PLACEHOLDER_ASSET: 'The only picture found is a tiny site icon, not a logo.',
  BAD_PROPORTIONS: 'The logo picture has odd proportions, so it is not safe to place without stretching it.',
  UNVERIFIED_PROVENANCE: 'It could not be shown that this picture is the business\'s own logo.',
  ICON_NOT_CONFIRMED: 'The site icon was not confirmed to be the same mark as the logo.',
  LOGO_COMPOSITOR_UNAVAILABLE: 'The real logo cannot be placed on posters yet, and this client requires one.',
};

export type LogoFileKind = 'png' | 'jpeg' | 'webp' | 'svg';

export interface LogoFileInfo {
  kind: LogoFileKind;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  /** Whether the file can carry transparency (a PNG with an alpha channel, a WebP with alpha, any SVG). */
  transparent: boolean;
}

export interface BrandingDecision {
  intendedMode: BrandingIntent;
  appliedMode: BrandingApplied;
  status: BrandingStatus;
  /** The logo's own shape: a full logo that carries the name, or a symbol alone. Only set when a trusted logo exists. */
  logoKind?: 'wordmark' | 'symbol';
  logoAssetSha256?: string;
  /** The frozen copy of the logo, relative to the brand folder, once it has been saved (see `freezeLogo`). */
  logoFile?: string;
  logoWidth?: number;
  logoHeight?: number;
  /** Where the logo was found on the website, and the exact address of the picture. */
  sourcePage?: string;
  sourceUrl?: string;
  /** How the picture was judged to be the business's own, in words. */
  provenance?: string;
  reasonCode?: BrandingReason;
  /** The reason in plain words, for the owner. */
  reason?: string;
}

export class BrandingError extends Error {
  readonly code: BrandingReason;
  constructor(code: BrandingReason, message: string) {
    super(message);
    this.name = 'BrandingError';
    this.code = code;
  }
}

/** Rules for a logo file to be trusted at all. The size limits are provisional: the placement step checks the logo against the size it is shown at. */
export const LOGO_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  wordmark: { minWidth: 320, minHeight: 48, minAspect: 0.25, maxAspect: 12 },
  symbol: { minSide: 128, minAspect: 0.4, maxAspect: 2.5 },
  /** A picture smaller than this on its longer side is a favicon, not a logo. */
  placeholderSide: 64,
} as const;

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function pngInfo(b: Buffer): Pick<LogoFileInfo, 'width' | 'height' | 'transparent'> | null {
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  const colorType = b[25];
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), transparent: colorType === 4 || colorType === 6 || b.includes(Buffer.from('tRNS')) };
}

function jpegInfo(b: Buffer): Pick<LogoFileInfo, 'width' | 'height' | 'transparent'> | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) { at += 1; continue; }
    const marker = b[at + 1] as number;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = b.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7), transparent: false };
    at += 2 + length;
  }
  return null;
}

function webpInfo(b: Buffer): Pick<LogoFileInfo, 'width' | 'height' | 'transparent'> | null {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), transparent: ((b[20] as number) & 0x10) !== 0 };
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, transparent: false };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, transparent: true };
  }
  return null;
}

/** A downloaded SVG is untrusted text: anything that could run or fetch something is a reason not to use it. */
export function svgIsSafe(text: string): boolean {
  if (/<\s*(script|foreignObject|iframe|object|embed|audio|video)\b/i.test(text)) return false;
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(text)) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false;
  if (/javascript\s*:/i.test(text)) return false;
  // Links may point inside the file (#id) or hold a picture inline; nothing else.
  for (const match of text.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const target = (match[1] as string).trim();
    if (!target.startsWith('#') && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(target)) return false;
  }
  if (/url\(\s*["']?\s*(?!#|data:image\/)[a-z]+:/i.test(text)) return false;
  return true;
}

function svgInfo(text: string): Pick<LogoFileInfo, 'width' | 'height' | 'transparent'> | null {
  const open = /<svg\b[^>]*>/i.exec(text)?.[0];
  if (!open) return null;
  const box = /viewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(open);
  if (box && Number(box[3]) > 0 && Number(box[4]) > 0) return { width: Number(box[3]), height: Number(box[4]), transparent: true };
  const w = /\swidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(open);
  const h = /\sheight\s*=\s*["']([\d.]+)(px)?["']/i.exec(open);
  return w && h && Number(w[1]) > 0 && Number(h[1]) > 0 ? { width: Number(w[1]), height: Number(h[1]), transparent: true } : null;
}

/** Reads a logo file's type, size and hash from its own bytes (nothing is trusted from its name), or says why it cannot be used. */
export function inspectLogoFile(path: string): LogoFileInfo {
  let bytes: Buffer;
  try {
    if (statSync(path).size > LOGO_LIMITS.maxBytes) throw new BrandingError('FILE_TOO_LARGE', `${path} is larger than ${LOGO_LIMITS.maxBytes} bytes`);
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof BrandingError) throw error;
    throw new BrandingError('FILE_UNREADABLE', `${path} could not be read`);
  }
  const ext = extname(path).toLowerCase();
  const png = pngInfo(bytes);
  if (png) return { kind: 'png', ...png, bytes: bytes.length, sha256: sha256(bytes) };
  const jpeg = jpegInfo(bytes);
  if (jpeg) return { kind: 'jpeg', ...jpeg, bytes: bytes.length, sha256: sha256(bytes) };
  const webp = webpInfo(bytes);
  if (webp) return { kind: 'webp', ...webp, bytes: bytes.length, sha256: sha256(bytes) };
  if (ext === '.svg' || bytes.subarray(0, 512).toString('utf8').includes('<svg')) {
    const text = bytes.toString('utf8');
    if (!svgIsSafe(text)) throw new BrandingError('UNSAFE_SVG', `${path} contains something that could run or fetch another file`);
    const svg = svgInfo(text);
    if (!svg) throw new BrandingError('UNSUPPORTED_FILE_TYPE', `${path} is an SVG without a size`);
    return { kind: 'svg', ...svg, bytes: bytes.length, sha256: sha256(bytes) };
  }
  throw new BrandingError('UNSUPPORTED_FILE_TYPE', `${path} is not a PNG, JPG, WebP or SVG picture`);
}

/** Whether the file is good enough to be used as this shape of logo; says why not, in a code. */
export function logoFileProblem(info: LogoFileInfo, shape: 'wordmark' | 'symbol'): BrandingReason | null {
  const { width, height } = info;
  const aspect = width / height;
  if (info.kind !== 'svg' && Math.max(width, height) < LOGO_LIMITS.placeholderSide) return 'PLACEHOLDER_ASSET';
  if (shape === 'wordmark') {
    const rule = LOGO_LIMITS.wordmark;
    if (aspect < rule.minAspect || aspect > rule.maxAspect) return 'BAD_PROPORTIONS';
    if (info.kind !== 'svg' && (width < rule.minWidth || height < rule.minHeight)) return 'INSUFFICIENT_RESOLUTION';
    return null;
  }
  const rule = LOGO_LIMITS.symbol;
  if (aspect < rule.minAspect || aspect > rule.maxAspect) return 'BAD_PROPORTIONS';
  if (info.kind !== 'svg' && Math.min(width, height) < rule.minSide) return 'INSUFFICIENT_RESOLUTION';
  return null;
}

export interface BrandingInput {
  /** The brand profile's logo fields. */
  brand: Pick<Brand, 'logo' | 'logoSource' | 'logoIcon'>;
  /** The brand's folder, which the logo file's path is relative to. */
  brandDir: string;
  /** The client's setting: a real logo is required on every poster. */
  requireAuthenticLogo: boolean;
  /** Whether the code that places a real logo on a finished poster exists and is switched on. */
  compositorReady: boolean;
}

/** The logo file inside the brand's folder, never outside it (a profile naming a path elsewhere is not followed). */
function fileInside(brandDir: string, relative: string): string | null {
  const root = resolve(brandDir);
  const target = resolve(root, relative);
  return target.startsWith(root + sep) ? target : null;
}

interface Candidate {
  file: string;
  shape: 'wordmark' | 'symbol';
  sourcePage?: string;
  sourceUrl?: string;
  provenance: string;
}

/** Whether the site's own pages say this picture is the business's logo: placed in its header or home link, saying so by its name or alt text. */
function provenanceOf(source: NonNullable<Brand['logoSource']>): { trusted: true; text: string } | { trusted: false } {
  const p = source.provenance;
  if (!p || p.signals.length === 0) return { trusted: false };
  const placed = p.placement === 'header_or_nav' ? 'in the site\'s header' : 'as the home-page link';
  // A picture served from another domain is the business's own only when it also names the business.
  if (p.hostRelation === 'third_party' && !p.signals.includes('names the business')) return { trusted: false };
  return { trusted: true, text: `${placed}; ${p.signals.join(' and ')}; ${p.hostRelation === 'same_site' ? 'served from the site itself' : 'served from another domain'}` };
}

/**
 * Finds the one logo that may be used and why, or the reason none can. A full logo from the site wins over its icon. The decision is a plain record:
 * saving the file's copy is a separate step (`freezeLogo`) so that deciding never writes anything.
 */
export function resolveBranding(input: BrandingInput): BrandingDecision {
  const { brand, brandDir } = input;
  const source = brand.logoSource;
  const fallback = (reasonCode: BrandingReason): BrandingDecision => unusable(input, reasonCode);

  const candidates: Array<{ candidate: Candidate } | { reason: BrandingReason }> = [];
  if (!source || (source.kind as LogoKind) === 'name-only') {
    candidates.push({ reason: source ? 'ONLY_NAME_AVAILABLE' : 'NO_LOGO_FOUND' });
  } else if (source.kind === 'site-logo') {
    const file = brand.logo ? fileInside(brandDir, brand.logo) : null;
    const trust = provenanceOf(source);
    if (!file || !existsSync(file)) candidates.push({ reason: 'FILE_UNREADABLE' });
    else if (!trust.trusted) candidates.push({ reason: 'UNVERIFIED_PROVENANCE' });
    else candidates.push({ candidate: { file, shape: 'wordmark', sourcePage: source.foundOn, ...(source.imageUrl ? { sourceUrl: source.imageUrl } : {}), provenance: trust.text } });
  }
  // The site's own icon is a symbol alone. It is used only when a model confirmed it is the same mark as the logo, or when the icon is all the site has.
  if (brand.logoIcon && brand.logoIcon.matchesLogo) {
    const file = fileInside(brandDir, brand.logoIcon.savedAs);
    if (file && existsSync(file)) candidates.push({ candidate: { file, shape: 'symbol', ...(source ? { sourcePage: source.foundOn } : {}), sourceUrl: brand.logoIcon.imageUrl, provenance: 'the site\'s icon, confirmed to be the same mark as its logo' } });
  } else if (brand.logoIcon) {
    candidates.push({ reason: 'ICON_NOT_CONFIRMED' });
  } else if (source?.kind === 'site-icon') {
    candidates.push({ reason: 'ICON_NOT_CONFIRMED' });
  }

  let firstReason: BrandingReason | undefined;
  for (const entry of candidates) {
    if ('reason' in entry) { firstReason ??= entry.reason; continue; }
    const { candidate } = entry;
    let info: LogoFileInfo;
    try {
      info = inspectLogoFile(candidate.file);
    } catch (error) {
      firstReason ??= error instanceof BrandingError ? error.code : 'FILE_UNREADABLE';
      continue;
    }
    const problem = logoFileProblem(info, candidate.shape);
    if (problem) { firstReason ??= problem; continue; }
    return trusted(input, candidate, info);
  }
  return fallback(firstReason ?? 'NO_LOGO_FOUND');
}

function trusted(input: BrandingInput, candidate: Candidate, info: LogoFileInfo): BrandingDecision {
  const facts = {
    logoKind: candidate.shape,
    logoAssetSha256: info.sha256,
    logoWidth: info.width,
    logoHeight: info.height,
    ...(candidate.sourcePage ? { sourcePage: candidate.sourcePage } : {}),
    ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
    provenance: candidate.provenance,
  };
  if (input.compositorReady) return { intendedMode: 'authentic_logo', appliedMode: 'authentic_logo', status: 'applied', ...facts };
  // The real logo cannot be placed yet. A client that requires one is stopped; any other gets the text sign-off, and the record says so plainly.
  if (input.requireAuthenticLogo) return { intendedMode: 'authentic_logo', appliedMode: 'none', status: 'blocked', ...facts, reasonCode: 'LOGO_COMPOSITOR_UNAVAILABLE', reason: BRANDING_REASON_TEXT.LOGO_COMPOSITOR_UNAVAILABLE };
  return { intendedMode: 'authentic_logo', appliedMode: 'text_only', status: 'awaiting_compositor', ...facts, reasonCode: 'LOGO_COMPOSITOR_UNAVAILABLE', reason: 'A real logo was found and verified, but real logos are not placed on posters yet, so this poster uses the brand name and web address as text.' };
}

function unusable(input: BrandingInput, reasonCode: BrandingReason): BrandingDecision {
  const reason = BRANDING_REASON_TEXT[reasonCode];
  if (input.requireAuthenticLogo) return { intendedMode: 'logo_required_unavailable', appliedMode: 'none', status: 'blocked', reasonCode, reason };
  return { intendedMode: 'text_only_fallback', appliedMode: 'text_only', status: 'resolved', reasonCode, reason };
}

/** Whether pictures may be bought for this decision. A blocked one stops the job before anything is spent. */
export function assertMayDraw(decision: BrandingDecision): void {
  if (decision.status === 'blocked') throw new BrandingError(decision.reasonCode ?? 'NO_LOGO_FOUND', `LOGO_REQUIRED: ${decision.reason ?? 'a real logo is required and none can be used'}`);
}

/**
 * Saves a copy of the logo the decision rests on, under its own hash, in the brand's `branding` folder. A site may change or replace the file later; the copy is
 * what the poster was judged against. Returns the decision with the copy's path set, or the decision as it was when there is no logo to keep.
 */
export function freezeLogo(brandDir: string, decision: BrandingDecision, original: string | null): BrandingDecision {
  if (!decision.logoAssetSha256 || !original) return decision;
  const ext = extname(original).toLowerCase() || '.bin';
  const relative = join('branding', `${decision.logoAssetSha256}${ext}`);
  const target = join(brandDir, relative);
  mkdirSync(join(brandDir, 'branding'), { recursive: true });
  if (!existsSync(target)) copyFileSync(original, target);
  if (sha256(readFileSync(target)) !== decision.logoAssetSha256) throw new BrandingError('FILE_UNREADABLE', 'the saved copy of the logo does not match the original');
  return { ...decision, logoFile: relative };
}

/** The logo file a trusted decision came from (to freeze), found the same way `resolveBranding` found it. */
export function logoPathFor(input: Pick<BrandingInput, 'brand' | 'brandDir'>, decision: BrandingDecision): string | null {
  if (!decision.logoKind) return null;
  const relative = decision.logoKind === 'symbol' ? input.brand.logoIcon?.savedAs : input.brand.logo;
  return relative ? fileInside(input.brandDir, relative) : null;
}
