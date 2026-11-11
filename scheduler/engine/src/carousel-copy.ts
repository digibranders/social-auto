/**
 * The captions of a carousel, one for each channel. The Instagram caption is written first from the topic, the slide headlines and the verified facts and is checked
 * the way every caption is (the claim gate against the facts, the writing check, the channel's length and hashtag limits); the other channels' captions are then written
 * from it by the existing per-channel writer (network-captions.ts). The closing line is the brand's own and is added by code, never by the model.
 */
import type { AiConfig } from './ai.ts';
import { plainHeadline } from './ai-creative.ts';
import { tidyPunctuation } from './caption-text.ts';
import { checkCopy } from './copy-gate.ts';
import { checkCopyQuality } from './copy-quality.ts';
import { chatJson } from './llm.ts';
import { writeNetworkCaptions } from './network-captions.ts';
import { composeVariant, NETWORK_RULES, recommendedLengthText, type Network } from './networks.ts';
import { BudgetError } from './paid-ledger.ts';

export interface CarouselCaptionInput {
  ai: AiConfig;
  topic: string;
  /** The slides' headlines in order (the markers for accent words are removed here). */
  headlines: readonly string[];
  /** The exact words of the verified facts the slides rest on. */
  facts: readonly string[];
  /** The brand's own closing line, e.g. "Order at currycook.com (link in bio)"; the other channels get it without "(link in bio)". */
  closingLine: string;
  networks: readonly Network[];
  /** For tests: replaces the network call. */
  fetchFn?: typeof fetch;
}

export interface CarouselCaptions {
  /** The full text to send on each channel: caption, closing line and hashtags. */
  captions: Record<string, string>;
  /** Channels whose caption could not be written to the checks and was replaced by a plain one, with why. */
  fallback: Array<{ network: Network; reason: string }>;
}

const POST_ID = 'carousel';

const MAIN_SYSTEM = `You write the Instagram caption of one carousel post (several slides swiped through) for a small business, from its verified facts only.
Rules: use only what the facts state; add no numbers, prices, times, guarantees, awards, statistics or comparisons the facts do not state; say what the carousel is about in plain words and invite the reader to swipe; two or three short sentences; no closing line or link (it is added afterwards); at most the hashtags allowed.
Return JSON only: {"caption": string, "hashtags": ["#..."]}`;

interface Main { caption: string; hashtags: string[] }

function parseMain(value: unknown, input: CarouselCaptionInput): Main {
  const v = (typeof value === 'object' && value !== null ? value : {}) as { caption?: unknown; hashtags?: unknown };
  const rules = NETWORK_RULES.instagram;
  if (typeof v.caption !== 'string' || v.caption.trim() === '') throw new Error('the caption is empty');
  const caption = v.caption.trim();
  if (caption.length > rules.maxCaption - 140) throw new Error(`the caption is too long; keep it under ${rules.maxCaption - 140} characters`);
  const tags = Array.isArray(v.hashtags) ? v.hashtags : [];
  if (!tags.every((t) => typeof t === 'string' && /^#\S+$/.test(t))) throw new Error('every hashtag must be one word starting with #');
  const hashtags = (tags as string[]).slice(0, rules.maxHashtags);
  const headline = plainHeadline(input.headlines[0] ?? input.topic);
  const quality = checkCopyQuality({ headline, caption });
  if (quality) throw new Error(quality);
  const violations = checkCopy({ headline, subline: '', caption }, input.facts);
  if (violations.length > 0) throw new Error(`it says something the facts do not support: ${violations.map((x) => `"${x.sentence.slice(0, 80)}" ${x.reason}`).join('; ')}`);
  return { caption, hashtags };
}

/** One caption per channel asked for. A caption that cannot be made to pass the checks is replaced by a plain one built from the slide headlines (which passed them) and is reported. */
export async function writeCarouselCaptions(input: CarouselCaptionInput): Promise<CarouselCaptions> {
  if (input.networks.length === 0) throw new Error('a carousel needs at least one channel to write a caption for');
  const fallback: CarouselCaptions['fallback'] = [];
  let main: Main;
  try {
    main = await chatJson({
      ai: input.ai, ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}), system: MAIN_SYSTEM,
      user: JSON.stringify({ topic: input.topic, slide_headlines: input.headlines.map(plainHeadline), facts: input.facts, aim: recommendedLengthText('instagram'), max_hashtags: NETWORK_RULES.instagram.maxHashtags }),
      parse: (value) => parseMain(value, input),
    });
  } catch (error) {
    if (error instanceof BudgetError) throw error;
    main = { caption: input.headlines.map(plainHeadline).join(' '), hashtags: [] };
    fallback.push({ network: 'instagram', reason: error instanceof Error ? error.message : String(error) });
  }
  const full = `${tidyPunctuation(main.caption)}\n\n${input.closingLine}`;
  const written = await writeNetworkCaptions({ ai: input.ai, networks: input.networks, posts: [{ id: POST_ID, headline: plainHeadline(input.headlines[0] ?? input.topic), caption: full, hashtags: main.hashtags, facts: [...input.facts] }], ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}) });
  for (const f of written.report.fallback) fallback.push({ network: f.network, reason: f.reason });
  const variants = written.variants[POST_ID] ?? {};
  const captions = Object.fromEntries(input.networks.flatMap((network) => { const v = variants[network]; return v ? [[network, composeVariant(v)]] : []; }));
  return { captions, fallback };
}
