/**
 * Makes one carousel for a client and puts it in the owner's review queue. Started by the job runner for a "carousel" job; nothing is scheduled or published.
 *
 *   node src/carousel-cli.ts --site acme.com [--brand shop-1] --networks instagram,linkedin [--start 2026-11-18] [--time 10:00] [--utc-offset +05:30] [--require-logo]
 *
 * The website must already have been read (a saved profile and verified facts): a carousel is made from what the client's site states and the owner has not removed.
 */
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { aiConfigFromEnv } from './ai.ts';
import { slugFromSite } from './analyze.ts';
import { COMPOSITOR_READY, assertMayDraw, freezeLogo, logoPathFor, resolveBranding } from './branding.ts';
import { runCarousel } from './carousel-run.ts';
import { parseBrand, readJson } from './content.ts';
import { loadFacts } from './evidence-pipeline.ts';
import { logoForDraw, placeholderDeps, placeholderEnabled } from './placeholder-pictures.ts';
import { applyReview, loadReview } from './fact-review.ts';
import { isNetwork, NETWORKS, type Network } from './networks.ts';
import { BudgetError, budgetLimitsFromEnv, PaidLedger } from './paid-ledger.ts';
import { envFilePath, loadEnvIfPresent } from './platform.ts';
import { tomorrowAt } from './posting-plan.ts';

const BRANDS_ROOT = resolve('brands');
const OUT_ROOT = resolve('out');

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      site: { type: 'string' }, brand: { type: 'string' }, networks: { type: 'string' }, start: { type: 'string' }, time: { type: 'string', default: '10:00' }, 'utc-offset': { type: 'string', default: '+05:30' },
      env: { type: 'string' }, 'require-logo': { type: 'boolean', default: false }, 'month-cap-usd': { type: 'string' },
    },
  });
  if (!values.site) throw new Error('Usage: --site <website> --networks <instagram,linkedin,...> [--start YYYY-MM-DD] [--time HH:MM]');
  const networks = (values.networks ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '');
  for (const n of networks) if (!isNetwork(n)) throw new Error(`--networks names ${NETWORKS.join(', ')}; "${n}" is not one of them`);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time)) throw new Error('--time must be HH:MM');
  if (!/^[+-](0\d|1[0-4]):[0-5]\d$/.test(values['utc-offset'])) throw new Error('--utc-offset must look like +05:30');
  if (values.start !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.start)) throw new Error('--start must be YYYY-MM-DD');

  loadEnvIfPresent(envFilePath(values.env, process.env));
  const ai = aiConfigFromEnv(process.env);
  // A product's customer is named by whoever owns the brand, never by the website (two customers may have the same one); our own clients are named after the site.
  const slug = values.brand ?? slugFromSite(values.site);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(slug)) throw new Error('--brand must be a brand name');
  const brandDir = join(BRANDS_ROOT, slug);
  const limits = budgetLimitsFromEnv(process.env);
  if (values['month-cap-usd'] !== undefined) {
    const cap = Number(values['month-cap-usd']);
    if (!Number.isFinite(cap) || cap <= 0) throw new Error('--month-cap-usd must be a positive number of dollars');
    limits.perBrandMonthUsd = cap;
  }
  ai.ledger = new PaidLedger(resolve(process.env['PAID_LEDGER_FILE'] || join(BRANDS_ROOT, '..', 'ledger', 'paid-calls.jsonl')), limits, { jobId: `${slug}-carousel-${Date.now()}`, tenantId: 'owner', brandId: slug });

  try {
    await access(join(brandDir, 'brand.json'));
  } catch {
    throw new Error(`there is no saved profile for ${values.site}: write posts for the website once first, so it is read`);
  }
  const brand = parseBrand(await readJson(join(brandDir, 'brand.json')), 'brand.json');
  const loaded = await loadFacts(brandDir);
  if (!loaded) throw new Error(`there are no verified facts for ${values.site}: write posts for the website once first, so it is read`);
  const facts = applyReview(loaded.facts.filter((f) => f.status === 'usable'), await loadReview(brandDir)).facts;

  // The real logo goes on the last slide only. A client that requires it is stopped before anything is bought when it cannot be had.
  const brandingInput = { brand, brandDir, requireAuthenticLogo: values['require-logo'], compositorReady: COMPOSITOR_READY };
  const decided = resolveBranding(brandingInput);
  assertMayDraw(decided);
  const branding = freezeLogo(brandDir, decided, logoPathFor(brandingInput, decided));
  console.log(`    Branding: ${branding.intendedMode} intended, ${branding.appliedMode} applied${branding.reason ? ` (${branding.reason})` : ''}`);
  // Not in placeholder mode: a placeholder card has no calm corner for the logo.
  const logo = logoForDraw(process.env, branding.status === 'applied' && branding.logoFile && branding.logoKind && branding.logoAssetSha256 ? { path: join(brandDir, branding.logoFile), kind: branding.logoKind, sha256: branding.logoAssetSha256 } : undefined);
  if (placeholderEnabled(process.env)) console.log('    PLACEHOLDER PICTURES: no picture model is called; these are plain stand-ins for local testing, never for a real customer.');

  const start = values.start ?? tomorrowAt(values['utc-offset']);
  const result = await runCarousel({
    ai, brand, brandSlug: slug, brandDir, facts, networks: networks as Network[], date: `${start}T${values.time}:00${values['utc-offset']}`, outRoot: OUT_ROOT, ...(logo ? { logo } : {}),
    log: (m) => console.log(m),
    // Local testing with no picture model (PICTURE_MODE=placeholder and LOCAL_PLACEHOLDER_PICTURES=yes): plain stand-ins, everything after them the normal pipeline.
    ...(placeholderEnabled(process.env) ? { deps: { slides: placeholderDeps({ ai }) } } : {}),
  });
  console.log(ai.usage.format());
  if (result.status !== 'queued') {
    const reason = result.reason ?? result.status;
    // A spending stop is reported the way the autopilot reports one, so a client's plan stops trying more days that would be refused the same way.
    console.error(/POSTER_BUDGET|RUN_BUDGET|BRAND_DAY_BUDGET|BRAND_MONTH_BUDGET|GLOBAL_DAY_BUDGET|KILL_SWITCH/.test(reason) ? `BUDGET_EXHAUSTED: ${reason}. Nothing more was bought; what was already made is kept.` : `CAROUSEL_NOT_MADE: ${reason}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof BudgetError) console.error(`BUDGET_EXHAUSTED (${error.code}): ${error.message}. Nothing more was bought; what was already made is kept.`);
  else console.error(`CAROUSEL_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
