import { writeFile } from 'node:fs/promises';
import { generateImage as generatePollinationsImage, ImageGenerationError, resolveImageModel } from './pollinations.ts';

/**
 * Which AI service writes the text and draws the pictures, and with what settings. OpenAI is the main provider when
 * its key is set; Pollinations is the backup (used when OpenAI fails or refuses, if its key is set too).
 * Everything comes from the environment, so changing a model is a settings change, not a code change.
 */
export type ProviderName = 'openai' | 'pollinations';
export type ImageQuality = 'low' | 'medium' | 'high';

export interface AiConfig {
  primary: ProviderName;
  /** Try the other provider when the main one fails (only when its key is set). */
  fallback: boolean;
  openaiKey: string | null;
  pollinationsKey: string | null;
  openaiBase: string;
  textModel: string;
  imageModel: string;
  imageQuality: ImageQuality;
  /** The most pictures one run may order from OpenAI, so a mistake cannot run up a bill. */
  maxOpenAiImages: number;
  pollinationsImageModel: string;
}

export class AiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

type Env = Record<string, string | undefined>;

const POLLINATIONS_CHAT = 'https://gen.pollinations.ai/v1/chat/completions';
export const POLLINATIONS_TEXT_MODELS = ['openai/gpt-6-luna', 'deepseek/deepseek-v4-flash'] as const;
const QUALITIES: readonly ImageQuality[] = ['low', 'medium', 'high'];

export function aiConfigFromEnv(env: Env): AiConfig {
  const openaiKey = env['OPENAI_API_KEY'] || null;
  const pollinationsKey = env['POLLINATIONS_API_KEY'] || null;
  if (!openaiKey && !pollinationsKey) throw new AiConfigError('Set OPENAI_API_KEY (or POLLINATIONS_API_KEY) so the engine can write posts');

  const asked = env['AI_PROVIDER'];
  if (asked !== undefined && asked !== '' && asked !== 'openai' && asked !== 'pollinations') throw new AiConfigError('AI_PROVIDER must be "openai" or "pollinations"');
  const primary: ProviderName = asked === 'openai' || asked === 'pollinations' ? asked : openaiKey ? 'openai' : 'pollinations';
  if (primary === 'openai' && !openaiKey) throw new AiConfigError('AI_PROVIDER is openai but OPENAI_API_KEY is not set');
  if (primary === 'pollinations' && !pollinationsKey) throw new AiConfigError('AI_PROVIDER is pollinations but POLLINATIONS_API_KEY is not set');

  const quality = env['OPENAI_IMAGE_QUALITY'] || 'medium';
  if (!(QUALITIES as readonly string[]).includes(quality)) throw new AiConfigError(`OPENAI_IMAGE_QUALITY must be one of ${QUALITIES.join(', ')}`);
  const limit = env['OPENAI_MAX_IMAGES_PER_RUN'] ? Number(env['OPENAI_MAX_IMAGES_PER_RUN']) : 40;
  if (!Number.isInteger(limit) || limit < 1) throw new AiConfigError('OPENAI_MAX_IMAGES_PER_RUN must be a whole number of at least 1');

  const other = primary === 'openai' ? pollinationsKey : openaiKey;
  return {
    primary,
    fallback: env['AI_FALLBACK'] !== 'off' && Boolean(other),
    openaiKey,
    pollinationsKey,
    openaiBase: (env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    textModel: env['OPENAI_TEXT_MODEL'] || 'gpt-6.1-terra',
    imageModel: env['OPENAI_IMAGE_MODEL'] || 'gpt-image-2.5-flare',
    imageQuality: quality as ImageQuality,
    maxOpenAiImages: limit,
    pollinationsImageModel: resolveImageModel(undefined, env),
  };
}

/** Provider names in the order they are tried. */
function order(ai: AiConfig): ProviderName[] {
  const other: ProviderName = ai.primary === 'openai' ? 'pollinations' : 'openai';
  return ai.fallback ? [ai.primary, other] : [ai.primary];
}

/** Provider error text with anything that looks like a key removed, so a log or alert never carries one. */
export function redact(text: string): string {
  return text.replace(/\b(sk|pk)-[A-Za-z0-9_-]{4,}/g, '$1-…');
}

export interface TextCandidate {
  label: 'OpenAI' | 'Pollinations';
  endpoint: string;
  apiKey: string;
  model: string;
}

/** The text models to try, best first. */
export function textCandidates(ai: AiConfig): TextCandidate[] {
  return order(ai).flatMap((provider): TextCandidate[] =>
    provider === 'openai'
      ? [{ label: 'OpenAI', endpoint: `${ai.openaiBase}/chat/completions`, apiKey: ai.openaiKey as string, model: ai.textModel }]
      : POLLINATIONS_TEXT_MODELS.map((model) => ({ label: 'Pollinations' as const, endpoint: POLLINATIONS_CHAT, apiKey: ai.pollinationsKey as string, model })),
  );
}

export interface SceneRequest {
  prompt: string;
  outPath: string;
  width: number;
  height: number;
  /** Used by Pollinations to keep re-runs the same; OpenAI has no seed. */
  seed: number;
}

/** Counts what a run has ordered from OpenAI, shared by every picture of the run. */
export interface ImageBudget {
  openaiImages: number;
}

async function openaiImage(ai: AiConfig, request: SceneRequest, budget: ImageBudget, fetchFn: typeof fetch): Promise<void> {
  if (budget.openaiImages >= ai.maxOpenAiImages) throw new ImageGenerationError(`OpenAI image limit of ${ai.maxOpenAiImages} per run reached`);
  const response = await fetchFn(`${ai.openaiBase}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ai.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.imageModel, prompt: request.prompt, n: 1, size: '1024x1024', quality: ai.imageQuality, output_format: 'jpeg' }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await response.json().catch(() => null)) as { data?: Array<{ b64_json?: string }>; error?: { message?: string } } | null;
  if (!response.ok) throw new ImageGenerationError(`OpenAI image request returned ${response.status}: ${redact(body?.error?.message ?? 'no details').slice(0, 300)}`);
  const encoded = body?.data?.[0]?.b64_json;
  if (!encoded) throw new ImageGenerationError('OpenAI returned no picture');
  await writeFile(request.outPath, Buffer.from(encoded, 'base64'));
  budget.openaiImages += 1;
}

/** Makes one scene picture with the main provider, then the backup if that fails. Returns who made it. */
export async function generateScene(ai: AiConfig, request: SceneRequest, budget: ImageBudget, fetchFn: typeof fetch = fetch): Promise<'OpenAI' | 'Pollinations'> {
  const failures: string[] = [];
  for (const provider of order(ai)) {
    try {
      if (provider === 'openai') {
        await openaiImage(ai, request, budget, fetchFn);
        return 'OpenAI';
      }
      await generatePollinationsImage({ ...request, apiKey: ai.pollinationsKey as string, model: ai.pollinationsImageModel, fetchFn });
      return 'Pollinations';
    } catch (error) {
      failures.push(redact(error instanceof Error ? error.message : String(error)));
    }
  }
  throw new ImageGenerationError(`No picture could be made. ${failures.join(' | ')}`);
}
