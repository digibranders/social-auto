/**
 * Local testing without the picture model: plain placeholder pictures, so the whole flow (the weekly draw, one picture per channel, the weekly limit, the review
 * screen) can be tried on a machine with no OpenAI key spent on pictures. Switched on only by PICTURE_MODE=placeholder together with LOCAL_PLACEHOLDER_PICTURES=yes
 * (two settings, so it cannot be turned on by mistake on a real server). Every placeholder carries the word PLACEHOLDER. The picture model and the vision check are
 * replaced; everything after them is the normal pipeline, and each placeholder is written to the paid ledger at no cost so the weekly limit still counts it.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { escapeHtml } from './content.ts';
import { captureHtml, type ChromeDeps } from './chrome-render.ts';
import { COMPOSITION_BY_NETWORK, NETWORKS, type Network } from './networks.ts';
import { CANVAS_SIZE } from './layout.ts';
import { jpegCommand } from './platform.ts';
import { defaultHeadlineGate } from './headline-gate.ts';
import type { AiConfig } from './ai.ts';
import type { CreativeReview } from './ai-creative.ts';
import type { CreativeDeps } from './ai-creative-pipeline.ts';

const run = promisify(execFile);

/** A colour of its own for each network, so the placeholders of one topic are told apart at a glance. */
export const PLACEHOLDER_COLOURS: Record<Network | 'plain', { bg: string; ink: string; name: string }> = {
  instagram: { bg: '#d6249f', ink: '#ffffff', name: 'Instagram' },
  facebook: { bg: '#1877f2', ink: '#ffffff', name: 'Facebook' },
  linkedin: { bg: '#0a66c2', ink: '#ffffff', name: 'LinkedIn' },
  google: { bg: '#34a853', ink: '#ffffff', name: 'Google' },
  plain: { bg: '#444444', ink: '#ffffff', name: 'Picture' },
};

export const placeholderEnabled = (env: Record<string, string | undefined>): boolean => env['PICTURE_MODE'] === 'placeholder' && env['LOCAL_PLACEHOLDER_PICTURES'] === 'yes';

/**
 * The real logo is not put on a placeholder: the card is only a stand-in with no calm corner to judge, so the logo-placement check would reject every one. In placeholder
 * mode the logo is left off; otherwise it is passed on unchanged.
 */
export function logoForDraw<T>(env: Record<string, string | undefined>, logo: T | undefined): T | undefined {
  return placeholderEnabled(env) ? undefined : logo;
}

/** The texts a picture is asked to carry, read from the prompt the pipeline built: the headline, the brand name and the web address. */
export function textsOfPrompt(prompt: string): string[] {
  const found = (label: string): string[] => [...prompt.matchAll(new RegExp(`\\d+\\. ${label}: "([^"]*)"`, 'g'))].map((m) => m[1] as string);
  return [...found('HEADLINE'), ...found('SUPPORTING LINE'), ...found('BRAND NAME'), ...found('WEB ADDRESS')].filter((t) => t.trim() !== '');
}

/** The network a prompt was built for: its composition line names it. */
export const networkOfPrompt = (prompt: string): Network | undefined => NETWORKS.find((n) => prompt.includes(COMPOSITION_BY_NETWORK[n]));

/** The capture is always the engine's square canvas, whatever shape a network's picture has: a placeholder is only a stand-in. */
export function placeholderHtml(texts: string[], network: Network | undefined, width = CANVAS_SIZE, height = CANVAS_SIZE): string {
  const colour = PLACEHOLDER_COLOURS[network ?? 'plain'];
  const [headline = '', ...rest] = texts;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;background:${colour.bg};color:${colour.ink};font-family:Helvetica,Arial,sans-serif}
main{box-sizing:border-box;width:100%;height:100%;padding:72px;display:flex;flex-direction:column;justify-content:space-between}
h1{font-size:84px;line-height:1.05;margin:0}p{font-size:34px;margin:0;opacity:.9}.tag{font-size:30px;letter-spacing:.12em;opacity:.8}
</style></head><body><main><div class="tag">PLACEHOLDER · ${escapeHtml(colour.name.toUpperCase())}</div><h1>${escapeHtml(headline)}</h1><div>${rest.map((t) => `<p>${escapeHtml(t)}</p>`).join('')}</div></main></body></html>`;
}

/** What the stand-in for the vision check answers: every text the picture was asked to carry, read once, and nothing else. */
export const placeholderReview = (texts: string[]): CreativeReview => ({
  regions: texts.map((text) => ({ text, readable: true })),
  marks: { graphicalLogoOrIcon: false, badgeSealAwardOrCertification: false, inventedNumberPriceOrStatistic: false, interfaceOrScreenshotWithText: false, personPresentedAsCustomerOrEndorser: false, flagOrReligiousSymbol: false },
  relevance: 2, composition: 2, readableSmall: true, textOverImportantArt: false,
  people: { present: false, estimatedCount: 0, prominent: false, description: '' }, notes: 'placeholder picture',
});

export interface PlaceholderOptions {
  ai: AiConfig;
  chrome?: ChromeDeps;
  /** Turns the captured PNG into the JPEG the review needs; the real one uses sips or ImageMagick. */
  toJpeg?: (pngPath: string, jpgPath: string) => Promise<void>;
}

/** The picture call and the vision check of one run, replaced. */
export function placeholderDeps(options: PlaceholderOptions): Pick<CreativeDeps, 'scene' | 'review' | 'headlineGate'> {
  const textsOf = new Map<string, string[]>();
  const toJpeg = options.toJpeg ?? (async (png: string, jpg: string): Promise<void> => { const { file, args } = jpegCommand(process.platform, png, jpg, 90); await run(file, args); });
  return {
    headlineGate: { enabled: false, config: defaultHeadlineGate },
    scene: async (prompt, outPath) => {
      const texts = textsOfPrompt(prompt);
      const network = networkOfPrompt(prompt);
      const ledger = options.ai.ledger;
      // The placeholder is a picture to the ledger too, at no cost, so the weekly limit of a channel counts it.
      const call = ledger?.reserve({ operation: 'image', model: 'placeholder', ...(options.ai.usage.post !== null ? { postId: options.ai.usage.post } : {}), ...(options.ai.usage.network !== null ? { network: options.ai.usage.network } : {}), requestKey: `${prompt}|${outPath}`, maxCostUsd: 0 });
      const dir = await mkdtemp(join(tmpdir(), 'placeholder-'));
      try {
        const png = join(dir, 'p.png');
        await captureHtml(placeholderHtml(texts, network), png, options.chrome);
        await toJpeg(png, outPath);
        await readFile(outPath);
        textsOf.set(outPath, texts);
        if (call !== undefined) ledger?.complete(call, { actualCostUsd: 0 });
      } catch (error) {
        if (call !== undefined) ledger?.fail(call, 'the placeholder could not be made');
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    review: async (imagePath) => placeholderReview(textsOf.get(imagePath) ?? []),
  };
}
