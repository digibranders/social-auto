import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrandingError, assertMayDraw, freezeLogo, inspectLogoFile, logoFileProblem, logoPathFor, resolveBranding, svgIsSafe, type BrandingInput } from './branding.ts';
import type { Brand } from './content.ts';

const png = (width: number, height: number, alpha = true): Buffer => {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = alpha ? 6 : 2;
  return b;
};
const jpeg = (width: number, height: number): Buffer => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
const svg = (body = '<rect width="10" height="10"/>', size = 'viewBox="0 0 400 100"'): string => `<svg xmlns="http://www.w3.org/2000/svg" ${size}>${body}</svg>`;

function workspace(): { dir: string; put: (name: string, data: Buffer | string) => void; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'branding-'));
  mkdirSync(join(dir, 'assets'));
  return { dir, put: (name, data) => writeFileSync(join(dir, name), data), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const source = (over: Partial<NonNullable<Brand['logoSource']>> = {}): NonNullable<Brand['logoSource']> => ({
  kind: 'site-logo', foundOn: 'https://acme.test/', imageUrl: 'https://acme.test/logo.svg', savedAs: 'assets/logo.svg', contentType: 'image/svg+xml', bytes: 100, contentHash: 'x', fetchedAt: '2026-11-06T00:00:00Z', tried: [],
  provenance: { placement: 'header_or_nav', signals: ['says logo', 'names the business'], hostRelation: 'same_site' }, ...over,
});
type Over = Omit<Partial<BrandingInput>, 'brand'> & { brand?: Partial<BrandingInput['brand']> };
const input = (dir: string, over: Over = {}): BrandingInput => ({
  brand: { logo: 'assets/logo.svg', logoSource: source(), ...over.brand } as BrandingInput['brand'],
  brandDir: dir, requireAuthenticLogo: false, compositorReady: false, ...(({ brand: _b, ...rest }) => rest)(over),
});

test('a verified logo is recorded as intended but not applied while real logos cannot be placed, and as applied once they can', () => {
  const w = workspace();
  try {
    w.put('assets/logo.svg', svg());
    const now = resolveBranding(input(w.dir));
    assert.deepEqual([now.intendedMode, now.appliedMode, now.status, now.logoKind], ['authentic_logo', 'text_only', 'awaiting_compositor', 'wordmark']);
    assert.equal(now.reasonCode, 'LOGO_COMPOSITOR_UNAVAILABLE');
    assert.match(now.reason ?? '', /uses the brand name and web address as text/);
    assert.equal(now.sourcePage, 'https://acme.test/');
    assert.match(now.provenance ?? '', /in the site's header/);
    const later = resolveBranding(input(w.dir, { compositorReady: true }));
    assert.deepEqual([later.appliedMode, later.status], ['authentic_logo', 'applied']);
    assert.equal(later.logoAssetSha256, now.logoAssetSha256, 'the same file has the same hash');
    assert.doesNotThrow(() => assertMayDraw(now));
  } finally {
    w.done();
  }
});

test('a client that requires a real logo is stopped before anything is bought, even with a good logo, until logos can be placed', () => {
  const w = workspace();
  try {
    w.put('assets/logo.svg', svg());
    const stopped = resolveBranding(input(w.dir, { requireAuthenticLogo: true }));
    assert.deepEqual([stopped.intendedMode, stopped.appliedMode, stopped.status, stopped.reasonCode], ['authentic_logo', 'none', 'blocked', 'LOGO_COMPOSITOR_UNAVAILABLE']);
    assert.throws(() => assertMayDraw(stopped), /LOGO_REQUIRED/);
    assert.equal(resolveBranding(input(w.dir, { requireAuthenticLogo: true, compositorReady: true })).status, 'applied');
  } finally {
    w.done();
  }
});

test('with no usable logo the poster falls back to text unless a real logo is required, and the reason is the real one', () => {
  const w = workspace();
  try {
    const nameOnly = { logoSource: source({ kind: 'name-only', imageUrl: null, savedAs: null, provenance: undefined }) };
    const soft = resolveBranding(input(w.dir, { brand: nameOnly }));
    assert.deepEqual([soft.intendedMode, soft.appliedMode, soft.status, soft.reasonCode], ['text_only_fallback', 'text_only', 'resolved', 'ONLY_NAME_AVAILABLE']);
    const hard = resolveBranding(input(w.dir, { brand: nameOnly, requireAuthenticLogo: true }));
    assert.deepEqual([hard.intendedMode, hard.appliedMode, hard.status, hard.reasonCode], ['logo_required_unavailable', 'none', 'blocked', 'ONLY_NAME_AVAILABLE']);
    assert.throws(() => assertMayDraw(hard), /LOGO_REQUIRED/);
    assert.equal(resolveBranding(input(w.dir, { brand: { logoSource: undefined } })).reasonCode, 'NO_LOGO_FOUND');
    assert.equal(resolveBranding(input(w.dir)).reasonCode, 'FILE_UNREADABLE', 'the saved file is missing');
  } finally {
    w.done();
  }
});

test('a picture counts as the business\'s own logo only when the site\'s pages say so; a page that merely shows a picture is not enough', () => {
  const w = workspace();
  try {
    w.put('assets/logo.svg', svg());
    const withProvenance = (provenance: NonNullable<Brand['logoSource']>['provenance']) => resolveBranding(input(w.dir, { brand: { logoSource: source({ provenance }) } })).reasonCode;
    assert.equal(withProvenance(undefined), 'UNVERIFIED_PROVENANCE', 'an older profile with no record');
    assert.equal(withProvenance({ placement: 'header_or_nav', signals: [], hostRelation: 'same_site' }), 'UNVERIFIED_PROVENANCE');
    assert.equal(withProvenance({ placement: 'home_link', signals: ['says logo'], hostRelation: 'third_party' }), 'UNVERIFIED_PROVENANCE', 'another domain that does not name the business');
    assert.equal(withProvenance({ placement: 'home_link', signals: ['says logo', 'names the business'], hostRelation: 'third_party' }), 'LOGO_COMPOSITOR_UNAVAILABLE', 'a CDN that names the business is accepted');
  } finally {
    w.done();
  }
});

test('an SVG that could run or fetch something is never used, and one that only draws is', () => {
  assert.equal(svgIsSafe(svg()), true);
  assert.equal(svgIsSafe(svg('<path d="M0 0h10"/><image href="data:image/png;base64,AAAA"/>')), true, 'an inline picture is fine');
  assert.equal(svgIsSafe(svg('<use href="#a"/>')), true, 'a link inside the file is fine');
  for (const bad of ['<script>alert(1)</script>', '<rect onload="x()"/>', '<foreignObject><div/></foreignObject>', '<image href="https://evil.test/a.png"/>', '<use xlink:href="//evil.test/a.svg#x"/>', '<a href="javascript:alert(1)"/>', '<rect style="fill:url(https://evil.test/a)"/>']) {
    assert.equal(svgIsSafe(svg(bad)), false, bad);
  }
  assert.equal(svgIsSafe('<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"/>'), false);
  const w = workspace();
  try {
    w.put('assets/logo.svg', svg('<script>1</script>'));
    assert.equal(resolveBranding(input(w.dir)).reasonCode, 'UNSAFE_SVG');
  } finally {
    w.done();
  }
});

test('a file is read for what it really is, its size and its hash, whatever its name says', () => {
  const w = workspace();
  try {
    w.put('assets/a.svg', png(600, 120));
    w.put('assets/b.png', jpeg(500, 200));
    w.put('assets/c.png', 'not a picture');
    const a = inspectLogoFile(join(w.dir, 'assets/a.svg'));
    assert.deepEqual([a.kind, a.width, a.height, a.transparent], ['png', 600, 120, true]);
    assert.equal(a.sha256.length, 64);
    assert.deepEqual([inspectLogoFile(join(w.dir, 'assets/b.png')).kind, inspectLogoFile(join(w.dir, 'assets/b.png')).width], ['jpeg', 500]);
    assert.throws(() => inspectLogoFile(join(w.dir, 'assets/c.png')), (e: unknown) => e instanceof BrandingError && e.code === 'UNSUPPORTED_FILE_TYPE');
    assert.throws(() => inspectLogoFile(join(w.dir, 'assets/none.png')), (e: unknown) => e instanceof BrandingError && e.code === 'FILE_UNREADABLE');
    w.put('assets/big.png', Buffer.alloc(3 * 1024 * 1024));
    assert.throws(() => inspectLogoFile(join(w.dir, 'assets/big.png')), (e: unknown) => e instanceof BrandingError && e.code === 'FILE_TOO_LARGE');
  } finally {
    w.done();
  }
});

test('size and proportions: a favicon is not a logo, a small picture is refused rather than enlarged, a very long strip is refused rather than squeezed', () => {
  const info = (width: number, height: number) => ({ kind: 'png' as const, width, height, bytes: 1, sha256: 'x', transparent: true });
  assert.equal(logoFileProblem(info(32, 32), 'wordmark'), 'PLACEHOLDER_ASSET');
  assert.equal(logoFileProblem(info(200, 40), 'wordmark'), 'INSUFFICIENT_RESOLUTION');
  assert.equal(logoFileProblem(info(600, 120), 'wordmark'), null);
  assert.equal(logoFileProblem(info(1200, 60), 'wordmark'), 'BAD_PROPORTIONS');
  assert.equal(logoFileProblem(info(100, 100), 'symbol'), 'INSUFFICIENT_RESOLUTION');
  assert.equal(logoFileProblem(info(192, 192), 'symbol'), null);
  assert.equal(logoFileProblem(info(512, 64), 'symbol'), 'BAD_PROPORTIONS');
  assert.equal(logoFileProblem({ ...info(400, 100), kind: 'svg' }, 'wordmark'), null, 'an SVG has no pixel size to fail');
});

test('the site\'s icon is used as a symbol only when it was confirmed to match the logo, and the full logo wins when both are good', () => {
  const w = workspace();
  try {
    w.put('assets/icon.png', png(256, 256));
    const icon = { savedAs: 'assets/icon.png', imageUrl: 'https://acme.test/icon.png', contentType: 'image/png', contentHash: 'y', fetchedAt: 'x', matchesLogo: true };
    // The full logo is too small; the confirmed icon is used instead.
    w.put('assets/logo.png', png(100, 30));
    const small = { logo: 'assets/logo.png', logoIcon: icon };
    const symbol = resolveBranding(input(w.dir, { brand: small }));
    assert.deepEqual([symbol.logoKind, symbol.intendedMode, symbol.logoWidth], ['symbol', 'authentic_logo', 256]);
    // A good full logo wins over the icon.
    w.put('assets/logo.svg', svg());
    assert.equal(resolveBranding(input(w.dir, { brand: { logoIcon: icon } })).logoKind, 'wordmark');
    // An icon nobody confirmed is not used.
    const unconfirmed = resolveBranding(input(w.dir, { brand: { logo: 'assets/logo.png', logoIcon: { ...icon, matchesLogo: false } } }));
    assert.deepEqual([unconfirmed.intendedMode, unconfirmed.reasonCode], ['text_only_fallback', 'INSUFFICIENT_RESOLUTION']);
    // The icon alone, never checked against a logo, is not confirmed either.
    const alone = resolveBranding(input(w.dir, { brand: { logoSource: source({ kind: 'site-icon' }) } }));
    assert.equal(alone.reasonCode, 'ICON_NOT_CONFIRMED');
  } finally {
    w.done();
  }
});

test('a profile that names a file outside the brand folder is not followed', () => {
  const w = workspace();
  try {
    assert.equal(resolveBranding(input(w.dir, { brand: { logo: '../../../etc/hosts' } })).reasonCode, 'FILE_UNREADABLE');
    assert.equal(resolveBranding(input(w.dir, { brand: { logo: '/etc/hosts' } })).reasonCode, 'FILE_UNREADABLE');
  } finally {
    w.done();
  }
});

test('deciding writes nothing; freezing keeps a copy of the logo under its own hash, so a changed site cannot change what was judged', () => {
  const w = workspace();
  try {
    w.put('assets/logo.svg', svg());
    const decision = resolveBranding(input(w.dir));
    assert.equal(existsSync(join(w.dir, 'branding')), false, 'resolving does not write');
    const frozen = freezeLogo(w.dir, decision, logoPathFor({ brand: { logo: 'assets/logo.svg', logoIcon: undefined }, brandDir: w.dir }, decision));
    assert.equal(frozen.logoFile, join('branding', `${decision.logoAssetSha256}.svg`));
    assert.equal(readFileSync(join(w.dir, frozen.logoFile as string), 'utf8'), svg());
    // The site's file changes afterwards; the frozen copy does not.
    w.put('assets/logo.svg', svg('<circle r="5"/>'));
    assert.equal(readFileSync(join(w.dir, frozen.logoFile as string), 'utf8'), svg());
    // A decision with no logo has nothing to freeze.
    const none = resolveBranding(input(w.dir, { brand: { logoSource: undefined } }));
    assert.equal(freezeLogo(w.dir, none, null), none);
  } finally {
    w.done();
  }
});
