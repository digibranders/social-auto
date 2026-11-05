/**
 * EXPERIMENT, not part of the production pipeline: a complete poster made by the image model itself, with no layout family, slot or template. It exists to
 * answer one question: does letting the model compose the whole poster look better than a picture inside our renderer? Everything upstream is the production
 * pipeline's (the website, the brand, the verified fact and its approved headline); only the last stage differs. The model is asked to write the headline
 * exactly and nothing else, so what comes back is checked: a vision request transcribes the text on the poster and code compares it, because a picture of
 * words is never assumed to spell them right. Nothing here is called by autopilot, and a paid call needs the explicit flags of ai-poster-test.ts.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { redact, type AiConfig, type ImageBudget } from './ai.ts';
import { flatImageCost } from './usage.ts';
import { chatJson } from './llm.ts';

export class FullPosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FullPosterError';
  }
}

export interface FullPosterInput {
  /** The approved headline, as written (no accent markers). */
  headline: string;
  /** The approved subline, when the post has one. */
  subline?: string;
  /** The verified source fact the post was written from; the picture may show it but add nothing to it. */
  fact: string;
  brandName: string;
  colors: { background: string; ink: string; accent: string };
  /** The link shown as the call to action, when there is one. */
  host?: string;
  /** Whether a logo image is attached as a reference. */
  hasLogoReference: boolean;
}

/**
 * The prompt for a whole poster. It names what must be on the poster and what must not, and says nothing about where anything goes: no rectangle, zone,
 * panel or layout is described, so the model decides the composition.
 */
export function buildFullPosterPrompt(input: FullPosterInput): string {
  const lines = [
    'Design one complete, professional square social media advertisement (1:1). You decide the whole composition: the artwork, the typography, the hierarchy and the layout.',
    `The only text on the poster must be exactly these words, spelled exactly as written, with no other words, numbers or symbols anywhere: HEADLINE: "${input.headline}"`,
    ...(input.subline ? [`SUPPORTING LINE: "${input.subline}"`] : []),
    `Also show the brand name "${input.brandName}" as a small wordmark${input.hasLogoReference ? ' by copying the attached logo image exactly, without redrawing, restyling or altering it' : ''}${input.host ? `, and the web address "${input.host}" small` : ''}.`,
    `The message of the poster is only this verified fact: "${input.fact}". Create an original visual idea that makes this fact clear to a stranger who is scrolling past. Show what the fact states and nothing more: no extra claims, offers, prices, statistics, awards, testimonials or promises.`,
    `Use the brand's colours: background ${input.colors.background}, ink ${input.colors.ink}, accent ${input.colors.accent}. Make the headline large and easy to read, with strong contrast against whatever is behind it.`,
    'Keep every important element fully inside the frame, with comfortable margins. Do not copy any existing advertisement, brand, slogan or character.',
  ];
  return lines.join(' ');
}

/** Rough price of one poster, for the plan shown before anything is bought. */
export function estimatePosterCost(ai: Pick<AiConfig, 'imageQuality'>): number {
  return flatImageCost(ai.imageQuality);
}

export interface FullPosterRequest {
  prompt: string;
  outPath: string;
  /** A logo picture (png, jpeg or webp) to attach as a reference. */
  logoPath?: string;
}

const MIME: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** A logo file the image endpoint accepts as a reference, or undefined (an SVG, for instance, must be turned into a picture first). */
export function logoReferenceType(path: string | undefined): string | undefined {
  return path ? MIME[extname(path).toLowerCase()] : undefined;
}

/** Asks OpenAI, and only OpenAI, for a complete 1024 x 1024 poster; with a logo reference the edit endpoint is used. Records the cost. */
export async function generateFullPoster(ai: AiConfig, request: FullPosterRequest, budget: ImageBudget, fetchFn: typeof fetch = fetch): Promise<void> {
  if (!ai.openaiKey) throw new FullPosterError('a complete poster needs an OpenAI key');
  if (budget.openaiImages >= ai.maxOpenAiImages) throw new FullPosterError(`OpenAI image limit of ${ai.maxOpenAiImages} per run reached`);
  const type = logoReferenceType(request.logoPath);
  let response: Response;
  if (request.logoPath && type) {
    const form = new FormData();
    form.set('model', ai.imageModel);
    form.set('prompt', request.prompt);
    form.set('size', '1024x1024');
    form.set('quality', ai.imageQuality);
    form.set('output_format', 'jpeg');
    form.set('image', new Blob([await readFile(request.logoPath)], { type }), `logo${extname(request.logoPath)}`);
    response = await fetchFn(`${ai.openaiBase}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${ai.openaiKey}` }, body: form, signal: AbortSignal.timeout(240_000) });
  } else {
    response = await fetchFn(`${ai.openaiBase}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ai.imageModel, prompt: request.prompt, n: 1, size: '1024x1024', quality: ai.imageQuality, output_format: 'jpeg' }),
      signal: AbortSignal.timeout(240_000),
    });
  }
  const body = (await response.json().catch(() => null)) as { data?: Array<{ b64_json?: string }>; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } } | null;
  if (!response.ok) throw new FullPosterError(`OpenAI image request returned ${response.status}: ${redact(body?.error?.message ?? 'no details').slice(0, 300)}`);
  const encoded = body?.data?.[0]?.b64_json;
  if (!encoded) throw new FullPosterError('OpenAI returned no picture');
  await writeFile(request.outPath, Buffer.from(encoded, 'base64'));
  budget.openaiImages += 1;
  const counted = typeof body?.usage?.output_tokens === 'number' && body.usage.output_tokens > 0;
  ai.usage.add({ kind: 'image', model: ai.imageModel, inputTokens: body?.usage?.input_tokens ?? 0, outputTokens: body?.usage?.output_tokens ?? 0, ...(counted ? {} : { flatCost: flatImageCost(ai.imageQuality) }) });
}

export interface TextCheck {
  /** Every piece of text the model read on the poster. */
  transcript: string[];
  /** The headline appears on the poster exactly (ignoring case, spacing and punctuation). */
  headlineExact: boolean;
  /** The supporting line, when expected, appears exactly. */
  sublineExact: boolean | null;
  /** Words on the poster that are not in the headline, the supporting line, the brand name or the web address. */
  extraWords: string[];
}

const normal = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const words = (text: string): string[] => normal(text).split(' ').filter(Boolean);

/** Compares what is on the poster with what was asked for. Pure, so it can be tested without a model. */
export function compareText(expected: { headline: string; subline?: string; brandName: string; host?: string }, transcript: readonly string[]): TextCheck {
  const seen = normal(transcript.join(' '));
  const contains = (needle: string): boolean => ` ${seen} `.includes(` ${normal(needle)} `);
  const allowed = new Set([...words(expected.headline), ...words(expected.subline ?? ''), ...words(expected.brandName), ...words(expected.host ?? '')]);
  const extra = [...new Set(words(transcript.join(' ')).filter((w) => !allowed.has(w)))];
  return {
    transcript: [...transcript],
    headlineExact: contains(expected.headline),
    sublineExact: expected.subline ? contains(expected.subline) : null,
    extraWords: extra,
  };
}

const READ_SYSTEM = `You read the text on an image. List every separate piece of text that is visible on the poster, exactly as it appears, in reading order, including small text, logos' words and web addresses. Do not correct spelling, do not complete cut-off words, do not add words that are not there, and do not describe the picture. If there is no text return an empty list. Return JSON only: {"text":["..."]}`;

/** One vision request that transcribes the poster's text; the answer is compared in code with compareText. */
export async function readPosterText(ai: AiConfig, imagePath: string, fetchFn?: typeof fetch): Promise<string[]> {
  const bytes = await readFile(imagePath);
  return chatJson({
    ai,
    ...(fetchFn ? { fetchFn } : {}),
    system: READ_SYSTEM,
    user: 'Transcribe the text on this poster.',
    images: [`data:image/jpeg;base64,${bytes.toString('base64')}`],
    parse: (value) => {
      const list = (value as { text?: unknown }).text;
      if (!Array.isArray(list) || !list.every((t) => typeof t === 'string')) throw new Error('"text" must be a list of strings');
      return list.map((t) => (t as string).trim()).filter(Boolean);
    },
  });
}
