import { writeFile } from 'node:fs/promises';

const POLLINATIONS_IMAGE_ENDPOINT = 'https://gen.pollinations.ai/image/';
const DEFAULT_MODEL = 'zimage';

/**
 * The picture model: the --image-model flag, else POLLINATIONS_IMAGE_MODEL, else the free default. Paid models such
 * as openai/gpt-image-2.5-flare need credit on the Pollinations account.
 */
export function resolveImageModel(flag: string | undefined, env: Record<string, string | undefined>): string {
  return flag || env['POLLINATIONS_IMAGE_MODEL'] || DEFAULT_MODEL;
}
const REQUEST_TIMEOUT_MS = 120_000;

export class ImageGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

export interface GenerateImageOptions {
  apiKey: string;
  prompt: string;
  outPath: string;
  width: number;
  height: number;
  /** Fixed seed keeps re-runs reproducible for the same post. */
  seed: number;
  model?: string;
  /** For tests: replaces the network call. */
  fetchFn?: typeof fetch;
}

export async function generateImage(options: GenerateImageOptions): Promise<void> {
  const url = new URL(POLLINATIONS_IMAGE_ENDPOINT + encodeURIComponent(options.prompt));
  url.searchParams.set('model', options.model ?? DEFAULT_MODEL);
  url.searchParams.set('width', String(options.width));
  url.searchParams.set('height', String(options.height));
  url.searchParams.set('seed', String(options.seed));
  url.searchParams.set('nologo', 'true');

  const response = await (options.fetchFn ?? fetch)(url, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.startsWith('image/')) {
    const body = (await response.text()).slice(0, 300);
    throw new ImageGenerationError(`Pollinations returned ${response.status} (${contentType}): ${body}`);
  }
  await writeFile(options.outPath, Buffer.from(await response.arrayBuffer()));
}

/** Stable 31-bit seed derived from a post id. */
export function seedFromId(id: string): number {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 2_147_483_647;
}
