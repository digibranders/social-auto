/**
 * Renders a week plan into 1080x1080 JPGs plus a preview page.
 *
 *   node src/render.ts --brand brands/brandbasket --plan week-01.json [--env <keys file>] [--model <id>]
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { composeCaption, escapeHtml, parseBrand, parseWeekPlan, readJson, type PlannedPost } from './content.ts';
import { renderCreativePostHtml } from './creative.ts';
import { CANVAS_SIZE, renderPostHtml } from './layout.ts';
import { chromeArgs, chromePath, envFilePath, jpegCommand, loadEnvIfPresent } from './platform.ts';
import { measureLogoTone } from './logo-tone.ts';
import { aiConfigFromEnv, generateScene, type AiConfig, type ImageBudget } from './ai.ts';
import { seedFromId } from './pollinations.ts';
import { loadFontManifest, resolveFont, type FontManifest } from './fonts.ts';
import { renderPoster, type RenderOutcome } from './render-poster.ts';
import type { PosterBrand } from './compose.ts';
import type { RenderCandidate } from './art-resolve.ts';
import type { ArtRecord } from './art-options.ts';
import type { Brand } from './content.ts';

const run = promisify(execFile);
const JPEG_QUALITY = 90;
/** Some models (e.g. FLUX) need multiples of 32; the layout crops to the canvas. */
const SCENE_SIZE = Math.ceil(CANVAS_SIZE / 32) * 32;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function screenshot(htmlPath: string, pngPath: string): Promise<void> {
  const profile = await mkdtemp(join(tmpdir(), 'engine-chrome-'));
  try {
    await run(chromePath(process.env, process.platform), chromeArgs(profile, pngPath, pathToFileURL(htmlPath).href, CANVAS_SIZE, process.env));
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

async function toJpeg(pngPath: string, jpgPath: string): Promise<void> {
  const { file, args } = jpegCommand(process.platform, pngPath, jpgPath, JPEG_QUALITY);
  await run(file, args);
}

async function logoMarkup(logoPath: string): Promise<string> {
  if (extname(logoPath).toLowerCase() === '.svg') return readFile(logoPath, 'utf8');
  return `<img src="${pathToFileURL(logoPath).href}" alt="">`;
}

function previewHtml(brandName: string, posts: PlannedPost[]): string {
  const cards = posts
    .map(
      (p) => `<article>
  <img src="${p.id}.jpg" alt="${escapeHtml(p.headline.replaceAll('|', ''))}">
  <div class="meta"><b>${escapeHtml(p.id)}</b> · ${escapeHtml(p.date)}</div>
  <div class="pain">${escapeHtml(p.painPoint)}</div>
  <pre>${escapeHtml(composeCaption(p))}</pre>
</article>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(brandName)} week preview</title>
<style>
body{font-family:system-ui,sans-serif;background:#f6f5f2;color:#15161a;margin:0;padding:24px}
h1{font-size:22px;margin:0 0 20px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:20px}
article{background:#fff;border-radius:14px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
img{width:100%;border-radius:10px;display:block}
.meta{font-size:13px;margin:10px 0 4px;color:#555}.pain{font-size:13px;color:#8a6a3f;margin-bottom:8px}
pre{white-space:pre-wrap;font:14px/1.45 system-ui,sans-serif;margin:0}
</style></head><body><h1>${escapeHtml(brandName)} · ${posts.length} posts</h1><main>${cards}</main></body></html>`;
}

export interface RenderOptions {
  brandDir: string;
  planFile: string;
  ai: AiConfig;
  log?: (message: string) => void;
  /** Directory of verified local fonts (with manifest.json); without it posters use system fonts and say so. Defaults to FONTS_DIR. */
  fontsDir?: string;
  /** What to do with an art-directed post that cannot be rendered: "fail" (default) or, only when explicitly allowed, "legacy" to use the older renderer. */
  artFailure?: 'fail' | 'legacy';
}

/** What the art-directed poster needs from a brand profile. */
function posterBrand(brand: Brand, logoHtml: string | undefined, logoTone: PosterBrand['logoTone']): PosterBrand {
  const identity = brand.identity && brand.identity.kind !== 'name-only' ? brand.identity.line : undefined;
  const host = brand.handleUrl?.trim();
  return {
    name: brand.name,
    colors: brand.colors,
    ...(identity ? { identityLine: identity } : {}),
    ...(brand.cta ? { cta: { label: brand.cta.label, host: host || brand.cta.text } } : {}),
    ...(logoHtml ? { logoHtml } : {}),
    ...(logoTone ? { logoTone } : {}),
  };
}

export interface PostRenderRecord {
  postId: string;
  status: RenderOutcome['status'];
  optionId?: string;
  /** The art record of the candidate that rendered: what actually happened, not what was asked for. */
  record?: ArtRecord;
  /** Set when an art post that failed was rendered by the older renderer because that was explicitly allowed. */
  fallback?: 'legacy';
  solved?: Record<string, number>;
  warnings: RenderOutcome['warnings'];
  attempts: RenderOutcome['attempts'];
  chromeVersion: string;
  failure?: string;
}

/** Renders every post of a plan; AI scenes are cached per post id. Returns the output folder. */
export async function renderPlan(options: RenderOptions): Promise<string> {
  const log = options.log ?? console.log;
  const brand = parseBrand(await readJson(join(options.brandDir, 'brand.json')), 'brand.json');
  const plan = parseWeekPlan(await readJson(join(options.brandDir, options.planFile)), options.planFile);
  const outDir = resolve('out', basename(options.brandDir), basename(options.planFile, '.json'));
  await mkdir(outDir, { recursive: true });
  const logoHtml = await logoMarkup(join(options.brandDir, brand.logo));
  const logoTone = await measureLogoTone(join(options.brandDir, brand.logo));
  const budget: ImageBudget = { openaiImages: 0 };
  const fontsDir = options.fontsDir ?? process.env['FONTS_DIR'];
  const manifest: FontManifest | undefined = fontsDir ? await loadFontManifest(fontsDir) : undefined;
  const font = resolveFont(brand.font, manifest);
  const records: PostRenderRecord[] = [];

  for (const [index, post] of plan.posts.entries()) {
    if (plan.renderMode === 'art_v1' || post.art) {
      let failure: string | undefined;
      if (!post.art) {
        failure = `no art direction (${(post.artFailure?.reasons ?? ['none recorded']).join('; ')})`;
        records.push({ postId: post.id, status: 'render_failed', warnings: [], attempts: [], chromeVersion: '', failure });
      } else {
        const { art } = post;
        const makePicture = async (candidate: RenderCandidate): Promise<string | undefined> => {
          if (!candidate.imagePrompt) return undefined;
          const key = createHash('sha256').update(candidate.imagePrompt).digest('hex').slice(0, 12);
          const scenePath = join(outDir, `${post.id}-${key}-bg.jpg`);
          if (!(await exists(scenePath))) {
            log(`${post.id}: generating AI scene for ${candidate.optionId}…`);
            options.ai.usage.post = `${basename(options.brandDir)}-${post.id}`;
            const maker = await generateScene(options.ai, { prompt: candidate.imagePrompt, outPath: scenePath, width: SCENE_SIZE, height: SCENE_SIZE, seed: seedFromId(post.id) }, budget).finally(() => {
              options.ai.usage.post = null;
            });
            log(`${post.id}: scene made by ${maker}`);
          }
          return pathToFileURL(scenePath).href;
        };
        const pngPath = join(outDir, `${post.id}.png`);
        const outcome = await renderPoster({
          copy: { headline: post.headline, subline: post.subline, ...(post.listItems?.length ? { listItems: post.listItems } : {}), ...(art.figure ? { figure: art.figure } : {}), ...(art.quote ? { quote: art.quote } : {}) },
          brand: posterBrand(brand, logoHtml, logoTone),
          font,
          candidates: art.candidates,
          makePicture,
          outPng: pngPath,
        });
        records.push({
          postId: post.id, status: outcome.status, ...(outcome.optionId ? { optionId: outcome.optionId } : {}), ...(outcome.record ? { record: outcome.record } : {}),
          ...(outcome.solved ? { solved: outcome.solved } : {}), warnings: outcome.warnings, attempts: outcome.attempts, chromeVersion: outcome.chromeVersion, ...(outcome.failure ? { failure: outcome.failure } : {}),
        });
        if (outcome.status !== 'render_failed') {
          await toJpeg(pngPath, join(outDir, `${post.id}.jpg`));
          await rm(pngPath);
          log(`${post.id}: rendered (${outcome.status}${outcome.warnings.length ? `, ${outcome.warnings.map((w) => w.code).join(', ')}` : ''})`);
          continue;
        }
        failure = outcome.failure ?? 'render failed';
      }
      log(`${post.id}: art-directed render failed (${failure})`);
      if (options.artFailure !== 'legacy') continue;
      (records[records.length - 1] as PostRenderRecord).fallback = 'legacy';
      log(`${post.id}: using the older renderer, which was explicitly allowed for this brand`);
    }
    let visualUrl: string | undefined;
    if (post.mode === 'ai' && post.imagePrompt) {
      const scenePath = join(outDir, `${post.id}-bg.jpg`);
      if (!(await exists(scenePath))) {
        log(`${post.id}: generating AI scene…`);
        options.ai.usage.post = `${basename(options.brandDir)}-${post.id}`;
        const maker = await generateScene(options.ai, { prompt: post.imagePrompt, outPath: scenePath, width: SCENE_SIZE, height: SCENE_SIZE, seed: seedFromId(post.id) }, budget).finally(() => {
          options.ai.usage.post = null;
        });
        log(`${post.id}: scene made by ${maker}`);
      }
      visualUrl = pathToFileURL(scenePath).href;
    }
    const htmlPath = join(outDir, `${post.id}.html`);
    const pngPath = join(outDir, `${post.id}.png`);
    await writeFile(htmlPath, (post.format ? renderCreativePostHtml : renderPostHtml)({ brand, post, painPointNumber: index + 1, logoHtml, visualUrl, logoTone }));
    await screenshot(htmlPath, pngPath);
    await toJpeg(pngPath, join(outDir, `${post.id}.jpg`));
    await rm(pngPath);
    log(`${post.id}: rendered`);
  }

  await writeFile(join(outDir, 'preview.html'), previewHtml(brand.name, plan.posts.filter((p) => !records.some((r) => r.postId === p.id && r.status === 'render_failed' && r.fallback !== 'legacy'))));
  if (records.length > 0) await writeFile(join(outDir, 'render-report.json'), `${JSON.stringify(records, null, 2)}\n`);
  const failed = records.filter((r) => r.status === 'render_failed' && r.fallback !== 'legacy');
  if (failed.length > 0) throw new Error(`${failed.length} poster(s) could not be rendered: ${failed.map((r) => `${r.postId} (${r.failure ?? 'failed'})`).join('; ')}`);
  return outDir;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      brand: { type: 'string' },
      plan: { type: 'string' },
      env: { type: 'string' },
      model: { type: 'string' },
    },
  });
  if (!values.brand || !values.plan) {
    throw new Error('Usage: --brand <dir> --plan <file.json> [--env <path>] [--model <Pollinations picture model, used only for the backup>]');
  }
  const envPath = envFilePath(values.env, process.env);
  loadEnvIfPresent(envPath);
  const ai = aiConfigFromEnv(process.env);
  if (values.model) ai.pollinationsImageModel = values.model;
  const outDir = await renderPlan({ brandDir: resolve(values.brand), planFile: values.plan, ai });
  console.log(`Done: ${outDir}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    process.exitCode = 1;
  });
}
