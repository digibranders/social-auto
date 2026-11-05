import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { aiConfigFromEnv } from './ai.ts';
import type { SiteSnapshot } from './crawl.ts';
import type { FactsFile } from './evidence-pipeline.ts';
import { ensureSiteAssets, FACTS_MAX_AGE_DAYS } from './site-assets.ts';

const ai = () => aiConfigFromEnv({ OPENAI_API_KEY: 'sk-test-key-123456' });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const BRAND = { name: 'Acme', website: 'https://acme.example', handleUrl: 'acme.example', offer: 'o', audience: 'a', tone: 't', proofPoints: [], callToAction: 'c', rules: ['r'], colors: { background: '#FFFFFF', ink: '#111111', accent: '#FF0000', tile: '#EEEEEE' }, font: 'Inter', logo: 'assets/logo.png', mark: 'A', features: [{ icon: 'gear', title: 'Fast', detail: 'quick' }] };
const snapshot = (icons: string[]): SiteSnapshot => ({ origin: 'https://acme.example', pages: [], logoCandidates: [], iconCandidates: icons, colors: [], fonts: [], pageDecisions: [] }) as unknown as SiteSnapshot;
const factsFile = (builtAt: string): FactsFile => ({ version: 1, builtAt, site: 'https://acme.example', facts: [], conflicts: [], snapshots: [], coverage: { usable: 3, needsReview: 1, pages: 1, structured: 1, notes: [] } }) as unknown as FactsFile;
const verdict = (matches: boolean) => (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ matches, reason: 'x' }) } }] }), { status: 200 })) as unknown as typeof fetch;

async function folder(extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'site-assets-'));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'assets', 'logo.png'), PNG);
  await writeFile(join(dir, 'brand.json'), JSON.stringify({ ...BRAND, ...extra }));
  return dir;
}

test('a brand with only a website link gets its facts and its icon from one crawl', async () => {
  const dir = await folder();
  try {
    let crawls = 0;
    const report = await ensureSiteAssets({ brandDir: dir, site: 'acme.example', ai: ai() }, {
      crawl: async () => { crawls++; return snapshot(['https://acme.example/icon.png']); },
      buildFacts: async () => factsFile('2026-11-05T00:00:00.000Z'),
      fetchBytes: async () => ({ bytes: PNG, type: 'image/png' }) as never,
      fetchFn: verdict(true), now: () => new Date('2026-11-05T00:00:00Z'),
    });
    assert.equal(crawls, 1);
    assert.deepEqual({ crawled: report.crawled, factsBuilt: report.factsBuilt, iconCaptured: report.iconCaptured }, { crawled: true, factsBuilt: true, iconCaptured: true });
    const saved = JSON.parse(await readFile(join(dir, 'brand.json'), 'utf8')) as { logoIcon?: { matchesLogo: boolean }; name: string };
    assert.equal(saved.logoIcon?.matchesLogo, true);
    assert.equal(saved.name, 'Acme', 'the rest of the profile is kept as it was');
    assert.ok(JSON.parse(await readFile(join(dir, 'facts.json'), 'utf8')).builtAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fresh facts and a saved icon mean no crawl at all; facts older than the limit are read again', async () => {
  const icon = { savedAs: 'assets/icon.png', imageUrl: 'u', contentType: 'image/png', contentHash: 'h', fetchedAt: 't', matchesLogo: true };
  const dir = await folder({ logoIcon: icon });
  try {
    await writeFile(join(dir, 'facts.json'), JSON.stringify(factsFile('2026-11-01T00:00:00.000Z')));
    const never = async (): Promise<SiteSnapshot> => { throw new Error('should not crawl'); };
    const quiet = await ensureSiteAssets({ brandDir: dir, site: 'acme.example', ai: ai() }, { crawl: never, now: () => new Date('2026-11-05T00:00:00Z') });
    assert.equal(quiet.crawled, false);
    let rebuilt = 0;
    const stale = await ensureSiteAssets({ brandDir: dir, site: 'acme.example', ai: ai() }, {
      crawl: async () => snapshot([]), buildFacts: async () => { rebuilt++; return factsFile('2026-12-01T00:00:00.000Z'); },
      now: () => new Date(Date.parse('2026-11-01T00:00:00Z') + (FACTS_MAX_AGE_DAYS + 1) * 86_400_000),
    });
    assert.equal(rebuilt, 1);
    assert.equal(stale.factsBuilt, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a site with no icon is not crawled again on every run; a failed crawl or build never stops the run', async () => {
  const dir = await folder();
  try {
    await writeFile(join(dir, 'facts.json'), JSON.stringify(factsFile('2026-11-04T00:00:00.000Z')));
    const now = () => new Date('2026-11-05T00:00:00Z');
    let crawls = 0;
    const first = await ensureSiteAssets({ brandDir: dir, site: 'acme.example', ai: ai() }, { crawl: async () => { crawls++; return snapshot([]); }, now });
    assert.equal(first.iconCaptured, false);
    assert.match(first.notes.join(' '), /no icon that downloads/);
    await access(join(dir, 'assets', '.no-icon.json'));
    await ensureSiteAssets({ brandDir: dir, site: 'acme.example', ai: ai() }, { crawl: async () => { crawls++; return snapshot([]); }, now });
    assert.equal(crawls, 1, 'the second run does not look again');

    const other = await folder();
    try {
      const down = await ensureSiteAssets({ brandDir: other, site: 'acme.example', ai: ai() }, { crawl: async () => { throw new Error('site down'); }, now });
      assert.equal(down.crawled, false);
      assert.match(down.notes.join(' '), /site down/);
      const broken = await ensureSiteAssets({ brandDir: other, site: 'acme.example', ai: ai() }, { crawl: async () => snapshot(['https://acme.example/icon.png']), buildFacts: async () => { throw new Error('chrome missing'); }, fetchBytes: async () => ({ bytes: PNG, type: 'image/png' }) as never, fetchFn: verdict(false), now });
      assert.equal(broken.factsBuilt, false);
      assert.match(broken.notes.join(' '), /chrome missing/);
      assert.equal(broken.iconCaptured, true, 'one failure does not stop the other');
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
