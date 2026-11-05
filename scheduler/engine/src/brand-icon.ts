/**
 * Adds the site's own icon to an existing brand profile, so a poster can show the symbol alone: reads the site's declared icons (read only, as the crawl does),
 * saves the first that downloads as assets/icon.<ext>, asks a model once whether it is the same mark as in the logo, and records the answer in brand.json.
 *
 *   node src/brand-icon.ts --brand brands/digibranders [--env <keys file>]
 *
 * One cheap vision request (about a tenth of a cent) and no picture is bought. A brand with no icon that matches its logo keeps using the whole logo.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { aiConfigFromEnv } from './ai.ts';
import { crawlSite } from './crawl.ts';
import { parseBrand, readJson } from './content.ts';
import { captureBrandIcon } from './logo-assets.ts';
import { envFilePath, loadEnvIfPresent } from './platform.ts';
import { safeFetchBytes } from './safe-fetch.ts';
import { writeFileAtomic } from './art-pipeline.ts';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { brand: { type: 'string' }, env: { type: 'string' } } });
  if (!values.brand) throw new Error('Usage: --brand <dir> [--env <keys file>]');
  const brandDir = resolve(values.brand);
  const raw = await readJson(join(brandDir, 'brand.json'));
  const brand = parseBrand(raw, 'brand.json');
  loadEnvIfPresent(envFilePath(values.env, process.env));
  const ai = aiConfigFromEnv(process.env);
  const snapshot = await crawlSite(brand.website);
  const icon = await captureBrandIcon({ brandDir, brand, iconCandidates: snapshot.iconCandidates, ai, fetchBytes: (url) => safeFetchBytes(url, { maxBytes: 2_000_000, accept: 'image/*,*/*' }) });
  if (!icon) {
    console.log(`${brand.name}: the site declares no icon that downloads, so posters keep using the whole logo. Tried: ${snapshot.iconCandidates.join(', ') || 'none'}`);
    return;
  }
  await writeFileAtomic(join(brandDir, 'brand.json'), `${JSON.stringify({ ...(raw as object), logoIcon: icon }, null, 2)}\n`);
  console.log(`${brand.name}: icon ${icon.savedAs} from ${icon.imageUrl}; ${icon.matchesLogo ? 'confirmed to match the logo, so posters will show the symbol alone' : 'NOT confirmed as the logo\'s symbol, so posters keep the whole logo'}${icon.reason ? ` (${icon.reason})` : ''}`);
  console.log(ai.usage.format());
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
