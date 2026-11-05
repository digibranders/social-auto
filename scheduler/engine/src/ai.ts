import { writeFile } from 'node:fs/promises';
import { generateImage as generatePollinationsImage, ImageGenerationError, resolveImageModel } from './pollinations.ts';
import { flatImageCost, UsageTally, costOf, type FallbackFrom } from './usage.ts';
import { BudgetError, type PaidLedger } from './paid-ledger.ts';

/**
 * Which AI service writes the text and draws the pictures, and with what settings. OpenAI is the main provider when
 * its key is set. The other provider is a backup only when AI_FALLBACK=on says so: a failed paid request is otherwise an
 * error, never a quiet switch to a free model. When a backup does answer, it is said at once and recorded.
 * Everything comes from the environment, so changing a model is a settings change, not a code change.
 */
export type ProviderName = 'openai' | 'pollinations';
export type ImageQuality = 'low' | 'medium' | 'high';

export interface AiConfig {
  primary: ProviderName;
  /** Try the other provider when the main one fails. Only on with AI_FALLBACK=on (and its key set). */
  fallback: boolean;
  /** Where a notice goes when a backup provider answers instead of the one asked for. */
  warn: (message: string) => void;
  openaiKey: string | null;
  pollinationsKey: string | null;
  openaiBase: string;
  textModel: string;
  imageModel: string;
  imageQuality: ImageQuality;
  /** The most pictures one run may order from OpenAI, so a mistake cannot run up a bill. */
  maxOpenAiImages: number;
  pollinationsImageModel: string;
  /** What this run has asked of the AI and what it cost; printed at the end of a run. */
  usage: UsageTally;
  /** When set, every OpenAI call is reserved against the budget caps before it is sent and recorded after (see paid-ledger.ts). */
  ledger?: PaidLedger;
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
  const allowed = env['AI_FALLBACK'];
  if (allowed !== undefined && allowed !== '' && allowed !== 'on' && allowed !== 'off') throw new AiConfigError('AI_FALLBACK must be "on" or "off"');
  if (allowed === 'on' && !other) throw new AiConfigError(`AI_FALLBACK=on needs the other provider's key (${primary === 'openai' ? 'POLLINATIONS_API_KEY' : 'OPENAI_API_KEY'})`);
  return {
    primary,
    fallback: allowed === 'on',
    warn: (message) => console.warn(message),
    openaiKey,
    pollinationsKey,
    openaiBase: (env['OPENAI_BASE_URL'] || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    textModel: env['OPENAI_TEXT_MODEL'] || 'gpt-6-luna',
    imageModel: env['OPENAI_IMAGE_MODEL'] || 'gpt-image-2.5-sunburst',
    imageQuality: quality as ImageQuality,
    maxOpenAiImages: limit,
    pollinationsImageModel: resolveImageModel(undefined, env),
    usage: new UsageTally(),
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

/** The OpenAI size closest to the requested shape. */
export function openaiSizeFor(width: number, height: number): '1024x1024' | '1536x1024' | '1024x1536' {
  if (width / height >= 1.2) return '1536x1024';
  if (width / height <= 0.83) return '1024x1536';
  return '1024x1024';
}

async function openaiImage(ai: AiConfig, request: SceneRequest, budget: ImageBudget, fetchFn: typeof fetch, fallbackFrom?: FallbackFrom): Promise<void> {
  if (budget.openaiImages >= ai.maxOpenAiImages) throw new ImageGenerationError(`OpenAI image limit of ${ai.maxOpenAiImages} per run reached`);
  const ask = (size: string): Promise<Response> =>
    fetchFn(`${ai.openaiBase}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ai.imageModel, prompt: request.prompt, n: 1, size, quality: ai.imageQuality, output_format: 'jpeg' }),
      signal: AbortSignal.timeout(180_000),
    });
  const wanted = openaiSizeFor(request.width, request.height);
  // Reserved before anything is sent: a refusal (over a cap, a second picture for the poster, the same request already made) stops here.
  const ledger = ai.ledger;
  const callId = ledger?.reserve({ operation: 'image', model: ai.imageModel, ...(ai.usage.post !== null ? { postId: ai.usage.post } : {}), requestKey: `${request.prompt}|${request.width}x${request.height}|${ai.imageQuality}`, maxCostUsd: ledger.limits.imageReserveUsd });
  if (ledger && callId) ledger.markInFlight(callId);
  let response: Response;
  try {
    response = await ask(wanted);
    // A model that does not offer the shaped size answers 400: the square picture is the safe second try, cropped to the panel as before.
    if (response.status === 400 && wanted !== '1024x1024') response = await ask('1024x1024');
  } catch (error) {
    // The request left and no answer came back: it may have been accepted, so it is never sent again on its own.
    if (ledger && callId) ledger.markUnknown(callId, error instanceof Error ? error.message : String(error));
    throw error;
  }
  const body = (await response.json().catch(() => null)) as { data?: Array<{ b64_json?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } } | null;
  if (!response.ok) {
    if (ledger && callId) ledger.fail(callId, `status ${response.status}`);
    throw new ImageGenerationError(`OpenAI image request returned ${response.status}: ${redact(body?.error?.message ?? 'no details').slice(0, 300)}`);
  }
  const encoded = body?.data?.[0]?.b64_json;
  if (!encoded) {
    // The provider answered 2xx with nothing usable: the picture may still have been billed.
    if (ledger && callId) ledger.markUnknown(callId, 'answered without a picture');
    throw new ImageGenerationError('OpenAI returned no picture');
  }
  await writeFile(request.outPath, Buffer.from(encoded, 'base64'));
  budget.openaiImages += 1;
  const used = body?.usage;
  const counted = typeof used?.output_tokens === 'number' && used.output_tokens > 0;
  if (ledger && callId) {
    const price = costOf({ kind: 'image', model: ai.imageModel, inputTokens: used?.input_tokens ?? 0, outputTokens: used?.output_tokens ?? 0, ...(counted ? {} : { flatCost: flatImageCost(ai.imageQuality) }) });
    ledger.complete(callId, { actualCostUsd: price, inputTokens: used?.input_tokens ?? 0, outputTokens: used?.output_tokens ?? 0, outputPath: request.outPath });
  }
  ai.usage.add({
    kind: 'image',
    model: ai.imageModel,
    inputTokens: used?.input_tokens ?? 0,
    outputTokens: used?.output_tokens ?? 0,
    ...(counted ? {} : { flatCost: flatImageCost(ai.imageQuality) }),
    ...(fallbackFrom ? { fallbackFrom } : {}),
  });
}

/** The provider and picture model a request names, as shown in a notice or a record. */
function imageModelOf(ai: AiConfig, provider: ProviderName): string {
  return provider === 'openai' ? `OpenAI ${ai.imageModel}` : `Pollinations ${ai.pollinationsImageModel}`;
}

/** Makes one scene picture with the main provider; the backup is tried only when it is allowed. Returns who made it. */
export async function generateScene(ai: AiConfig, request: SceneRequest, budget: ImageBudget, fetchFn: typeof fetch = fetch): Promise<'OpenAI' | 'Pollinations'> {
  const failures: string[] = [];
  const providers = order(ai);
  for (const provider of providers) {
    const standingIn = provider !== providers[0];
    const fallbackFrom: FallbackFrom | undefined = standingIn ? { requested: imageModelOf(ai, providers[0] as ProviderName), reason: failures.at(-1) ?? 'unknown' } : undefined;
    try {
      if (provider === 'openai') await openaiImage(ai, request, budget, fetchFn, fallbackFrom);
      else {
        await generatePollinationsImage({ ...request, apiKey: ai.pollinationsKey as string, model: ai.pollinationsImageModel, fetchFn });
        ai.usage.add({ kind: 'image', model: `pollinations/${ai.pollinationsImageModel}`, inputTokens: 0, outputTokens: 0, ...(fallbackFrom ? { fallbackFrom } : {}) });
      }
    } catch (error) {
      // A spending refusal ends the picture: another provider is never used to get around a cap.
      if (error instanceof BudgetError) throw error;
      failures.push(redact(error instanceof Error ? error.message : String(error)));
      continue;
    }
    if (fallbackFrom) ai.warn(`WARNING: ${fallbackFrom.requested} failed (${fallbackFrom.reason}); ${imageModelOf(ai, provider)} made this picture instead (AI_FALLBACK=on).`);
    return provider === 'openai' ? 'OpenAI' : 'Pollinations';
  }
  throw new ImageGenerationError(`No picture could be made. ${failures.join(' | ')}`);
}
