import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import { parseBrand } from './content.ts';
import { captureBrandIcon, chooseLogoMark, iconMatchesLogo } from './logo-assets.ts';
import { chromePath } from './platform.ts';

const ai = () => aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-123456' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const verdict = (matches: boolean, reason = 'because') => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ matches, reason }) } }], usage: { prompt_tokens: 900, completion_tokens: 20 } }), { status: 200 })) as unknown as typeof fetch;
const real = { skip: existsSync(chromePath(process.env, process.platform)) ? false : 'Chrome is not installed' };

async function brandFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'icon-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'logo.png'), PNG);
  return dir;
}

test('the icon is saved beside the logo with its source and hash, and a confirmed match is recorded', async () => {
  const dir = await brandFolder();
  try {
    const icon = await captureBrandIcon({
      brandDir: dir, brand: { logo: 'assets/logo.png' }, iconCandidates: ['https://acme.example/icon.png'], ai: ai(), now: () => new Date('2026-11-05T00:00:00Z'), fetchFn: verdict(true, 'the same DB symbol'),
      fetchBytes: async () => ({ bytes: PNG, type: 'image/png' }) as never,
    });
    assert.ok(icon);
    assert.equal(icon.savedAs, 'assets/icon.png');
    assert.equal(icon.matchesLogo, true);
    assert.equal(icon.reason, 'the same DB symbol');
    assert.match(icon.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(icon.fetchedAt, '2026-11-05T00:00:00.000Z');
    assert.deepEqual(await readFile(join(dir, 'assets', 'icon.png')), PNG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a doubt, an unreadable icon or a failed check is recorded as no match, never as a match', async () => {
  const dir = await brandFolder();
  try {
    const fetchBytes = async () => ({ bytes: PNG, type: 'image/png' }) as never;
    const no = await captureBrandIcon({ brandDir: dir, brand: { logo: 'assets/logo.png' }, iconCandidates: ['https://acme.example/icon.png'], ai: ai(), fetchFn: verdict(false, 'a default globe'), fetchBytes });
    assert.equal(no?.matchesLogo, false);
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const failed = await captureBrandIcon({ brandDir: dir, brand: { logo: 'assets/logo.png' }, iconCandidates: ['https://acme.example/icon.png'], ai: ai(), fetchFn: failing, fetchBytes });
    assert.equal(failed?.matchesLogo, false);
    assert.match(failed?.reason ?? '', /could not run/);
    const ico = await captureBrandIcon({ brandDir: dir, brand: { logo: 'assets/logo.png' }, iconCandidates: ['https://acme.example/favicon.ico'], ai: ai(), fetchFn: verdict(true), fetchBytes: async () => ({ bytes: PNG, type: 'image/x-icon' }) as never });
    assert.equal(ico?.matchesLogo, false, 'an .ico cannot be shown to a model, so it is not confirmed');
    assert.equal(ico?.savedAs, 'assets/icon.ico');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a site with no icon that downloads has no icon record', async () => {
  const dir = await brandFolder();
  try {
    const none = await captureBrandIcon({ brandDir: dir, brand: { logo: 'assets/logo.png' }, iconCandidates: ['https://acme.example/missing.png'], ai: ai(), fetchBytes: async () => { throw new Error('404'); } });
    assert.equal(none, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the icon is shown alone only when it was confirmed to match the logo; otherwise the whole logo is', () => {
  const icon = { savedAs: 'assets/icon.png', imageUrl: 'u', contentType: 'image/png', contentHash: 'h', fetchedAt: 't' };
  assert.deepEqual(chooseLogoMark({ logo: 'assets/logo.svg', logoIcon: { ...icon, matchesLogo: true } }), { kind: 'icon', path: 'assets/icon.png' });
  assert.deepEqual(chooseLogoMark({ logo: 'assets/logo.svg', logoIcon: { ...icon, matchesLogo: false } }), { kind: 'logo', path: 'assets/logo.svg' });
  assert.deepEqual(chooseLogoMark({ logo: 'assets/logo.svg' }), { kind: 'logo', path: 'assets/logo.svg' });
});

test('the comparison request shows the model both pictures and reads a yes or no', async () => {
  const dir = await brandFolder();
  try {
    const logo = { path: join(dir, 'assets', 'logo.png'), mime: 'image/png' };
    let images = 0;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      images = (JSON.stringify(JSON.parse(init.body as string).messages).match(/data:image\/png;base64/g) ?? []).length;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ matches: true, reason: 'ok' }) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual(await iconMatchesLogo(ai(), logo, logo, fetchFn), { matches: true, reason: 'ok' });
    assert.equal(images, 2);
    await assert.rejects(iconMatchesLogo(ai(), logo, logo, (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ maybe: 1 }) } }] }), { status: 200 })) as unknown as typeof fetch), /No valid response/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a brand profile keeps its icon record, and a malformed one is refused', () => {
  const base = { name: 'Acme', website: 'https://acme.example', handleUrl: 'acme.example', offer: 'o', audience: 'a', tone: 't', proofPoints: [], callToAction: 'c', rules: ['r'], colors: { background: '#FFFFFF', ink: '#111111', accent: '#FF0000', tile: '#EEEEEE' }, font: 'Inter', logo: 'assets/logo.png', mark: 'A', features: [{ icon: 'gear', title: 'Fast', detail: 'quick' }] };
  const icon = { savedAs: 'assets/icon.png', imageUrl: 'https://acme.example/icon.png', contentType: 'image/png', contentHash: 'sha256:x', fetchedAt: '2026-11-05T00:00:00Z', matchesLogo: true };
  assert.equal(parseBrand({ ...base, logoIcon: icon }, 'b').logoIcon?.matchesLogo, true);
  assert.equal(parseBrand(base, 'b').logoIcon, undefined);
  assert.throws(() => parseBrand({ ...base, logoIcon: { ...icon, matchesLogo: 'yes' } }, 'b'), /matchesLogo/);
});

test('real Chrome: an SVG logo is drawn into a picture a model can look at', real, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'raster-'));
  try {
    const svg = join(dir, 'logo.svg');
    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect width="100" height="40" fill="#FF5542"/></svg>');
    const { rasterForModel } = await import('./logo-assets.ts');
    const raster = await rasterForModel(svg, join(dir, 'work'), 'logo');
    assert.equal(raster?.mime, 'image/png');
    assert.ok(raster && existsSync(raster.path));
    assert.equal(await rasterForModel(join(dir, 'x.ico'), join(dir, 'work'), 'x'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
