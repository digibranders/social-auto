import { writeFile } from 'node:fs/promises';

const POLLINATIONS_IMAGE_ENDPOINT = 'https://gen.pollinations.ai/image/';
const DEFAULT_MODEL = 'zimage';
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
}

export async function generateImage(options: GenerateImageOptions): Promise<void> {
  const url = new URL(POLLINATIONS_IMAGE_ENDPOINT + encodeURIComponent(options.prompt));
  url.searchParams.set('model', options.model ?? DEFAULT_MODEL);
  url.searchParams.set('width', String(options.width));
  url.searchParams.set('height', String(options.height));
  url.searchParams.set('seed', String(options.seed));
  url.searchParams.set('nologo', 'true');

  const response = await fetch(url, {
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
