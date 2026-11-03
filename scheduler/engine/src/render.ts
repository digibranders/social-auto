/**
 * Renders a week plan into 1080x1080 JPGs plus a preview page.
 *
 *   node src/render.ts --brand brands/brandbasket --plan week-01.json [--env <keys file>] [--model <id>]
 */
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
import { aiConfigFromEnv, generateScene, type AiConfig, type ImageBudget } from './ai.ts';
import { seedFromId } from './pollinations.ts';

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
}

/** Renders every post of a plan; AI scenes are cached per post id. Returns the output folder. */
export async function renderPlan(options: RenderOptions): Promise<string> {
  const log = options.log ?? console.log;
  const brand = parseBrand(await readJson(join(options.brandDir, 'brand.json')), 'brand.json');
  const plan = parseWeekPlan(await readJson(join(options.brandDir, options.planFile)), options.planFile);
  const outDir = resolve('out', basename(options.brandDir), basename(options.planFile, '.json'));
  await mkdir(outDir, { recursive: true });
  const logoHtml = await logoMarkup(join(options.brandDir, brand.logo));
  const budget: ImageBudget = { openaiImages: 0 };

  for (const [index, post] of plan.posts.entries()) {
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
    await writeFile(htmlPath, (post.format ? renderCreativePostHtml : renderPostHtml)({ brand, post, painPointNumber: index + 1, logoHtml, visualUrl }));
    await screenshot(htmlPath, pngPath);
    await toJpeg(pngPath, join(outDir, `${post.id}.jpg`));
    await rm(pngPath);
    log(`${post.id}: rendered`);
  }

  await writeFile(join(outDir, 'preview.html'), previewHtml(brand.name, plan.posts));
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
