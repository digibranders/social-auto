/**
 * Fully AI creatives: the image model draws the whole poster, headline included, with no template, layout family or compositing of our own. What is
 * kept from the engine is everything that makes a post true: the post's copy comes from verified facts, and what comes back is not trusted. A poster may
 * show exactly three things in words (its headline, the brand's name and the web address), nothing else, and never a drawn logo, badge, award or invented
 * number. One vision request transcribes every piece of text it can see and answers a short list of yes/no questions; the decision is made here, in
 * code, by comparing the transcript with the exact list of allowed text. When the reading is uncertain the poster is rejected.
 *
 * The real logo is not on these posters: a model cannot be made to copy a logo exactly, and a convincing imitation is worse than none, so the brand is
 * shown by its name in ordinary lettering and its address.
 */
import { readFile } from 'node:fs/promises';
import type { AiConfig } from './ai.ts';
import { chatJson } from './llm.ts';

export interface TextManifest {
  headline: string;
  /** Only when the poster is meant to carry a supporting line. */
  subline?: string;
  brandName: string;
  /** The brand's web address as shown, e.g. "oyechats.com". */
  domain: string;
}

/** A headline as plain text: the accent markers (|like this|) the template renderer used are removed. */
export const plainHeadline = (headline: string): string => headline.replace(/\|/g, '').replace(/\s+/g, ' ').trim();

/** The address as a person reads it: no scheme, no "www.", no path. */
export function displayDomain(website: string): string {
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.replace(/^www\./, '');
  } catch {
    return website.replace(/^https?:\/\//i, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

export interface CreativeContext {
  /** The verified fact the post is about; the artwork may show it but add nothing to it. */
  fact: string;
  colors: { background: string; ink: string; accent: string };
  /** The picture the creative director chose for this post, in its own words. When there is none the model is only asked for an original idea. */
  concept?: { concept: string; factToPicture: string; typography?: string };
  /** What the previous attempt got wrong, so the next one is told instead of repeating itself. */
  retryNote?: string;
}

/** The prompt for one whole poster. It names exactly what may be written on it and what must never appear, and leaves the composition to the model. */
export function buildCreativePrompt(manifest: TextManifest, context: CreativeContext): string {
  const lines = [
    'Generate one complete, original, square (1:1) social media advertisement. The whole poster, including typography, artwork, layout, hierarchy and composition, is designed by you as one unified creative: do not use a fixed poster template.',
    'TEXT CONTRACT. The only visible text on the poster is the following, each exactly once and spelled character for character:',
    `1. HEADLINE: "${manifest.headline}"`,
    ...(manifest.subline ? [`2. SUPPORTING LINE: "${manifest.subline}"`] : []),
    `${manifest.subline ? 3 : 2}. BRAND NAME: "${manifest.brandName}", as a clear sign-off in bold or semibold lettering, its letters at least 4 percent of the poster's height tall (about 40 pixels on a 1024 pixel poster), smaller than the headline but never small, with strong contrast against what is directly behind it, placed wherever it fits the composition naturally${manifest.headline.toLowerCase().includes(manifest.brandName.toLowerCase()) ? ' (it may be left out if the headline already names the brand)' : ''}.`,
    `${manifest.subline ? 4 : 3}. WEB ADDRESS: "${manifest.domain}", set at the same size and weight as the brand name, next to or directly beneath it, as part of the same sign-off.`,
    'Show no other words, letters, numbers or symbols that resemble writing anywhere: no labels, buttons, slogans, interface messages, captions, watermarks, signs, screens with writing, or made-up text.',
    'Never draw or imitate a logo, an app icon, a custom wordmark, a certification badge, a seal, a medal or an award.',
    ...(context.concept
      ? [
          `THE PICTURE (follow it; it was chosen for this post alone): ${context.concept.concept}`,
          `THE MESSAGE is only this verified fact: "${context.fact}". The picture communicates it like this: ${context.concept.factToPicture} Do not invent product screenshots, customer quotes, results, endorsements, statistics, prices, offers or any evidence. Any interface must be an obvious concept with no text in it. People appear only as generic illustrated or photographed subjects, never as real customers, employees or endorsers.`,
        ]
      : [
          `THE MESSAGE is only this verified fact: "${context.fact}".`,
          `THE VISUAL IDEA. Find the one concrete thing, action, object or situation that this exact fact is about, and make that the picture, so that a stranger scrolling past learns something from the picture itself and not only from the headline. The picture must have a visible, specific relationship to this fact: if you could put the same picture next to a different headline of this brand, the idea is too generic. Do not fall back on the usual stock illustration of business or marketing: people sitting at laptops, floating browser or app windows, targets, megaphones, growth arrows, rising charts, skylines, handshakes or lightbulbs. Show a person, a laptop or an interface only when the fact is actually about one. Invent the treatment fresh for this fact (the medium, the point of view, the scale, the composition, how the headline is set); it does not need to look like an illustration of people at work.`,
          'Do not invent product screenshots, customer quotes, results, endorsements, statistics, prices, offers or any evidence, and do not imply an outcome the fact does not state (no growth arrows, trophies or rising charts unless the fact says so). Any interface you show must be an obvious concept with no text in it. People may appear only as generic illustrated subjects, never as real customers, employees or endorsers.',
        ]),
    ...(context.concept?.typography
      ? [`TYPOGRAPHY (an essential part of the concept, not optional styling): ${context.concept.typography} Execute this as part of the advertisement's design: integrate the headline and the artwork into one intentional composition and follow the described scale, weight, colour and spatial relationship. Keep the headline's capitalisation and punctuation exactly as given. If a decorative treatment would endanger the spelling or legibility of any letter, simplify its execution, but do not fall back to a large black headline above the artwork.`]
      : []),
    `The brand's colours, for reference: ${context.colors.accent} as its accent, ${context.colors.ink} for text, ${context.colors.background} as its background. Use them where they suit the picture, as an accent or a detail; they need not fill the scene.`,
    `LEGIBILITY applies to every treatment: each required text is complete, uncropped and unobstructed, has strong contrast against what is directly behind it, and would still be readable if the poster were shown at 360 pixels wide. Keep every element inside the frame with comfortable margins.`,
    'It should look like a finished, professionally designed advertisement. Do not copy any existing advertisement, brand, slogan or character.',
    ...(context.retryNote ? [`CORRECTION. The previous attempt was rejected: ${context.retryNote} Fix exactly this and follow the text contract strictly.`] : []),
  ];
  return lines.join('\n');
}

// ---- Reading the poster

export interface CreativeReview {
  /** Every separate region of visible text, in reading order. `readable` is false when the model could not be sure what it says. */
  regions: Array<{ text: string; readable: boolean }>;
  marks: {
    graphicalLogoOrIcon: boolean;
    badgeSealAwardOrCertification: boolean;
    inventedNumberPriceOrStatistic: boolean;
    interfaceOrScreenshotWithText: boolean;
    personPresentedAsCustomerOrEndorser: boolean;
    flagOrReligiousSymbol: boolean;
  };
  /** 0 the picture does not communicate the message, 1 partly, 2 clearly. */
  relevance: number;
  /** 0 the headline is hard to read or cropped, 1 acceptable, 2 clear with margins. */
  composition: number;
  /** Whether the headline, the brand name and the web address would all still be readable if the poster were shown 360 pixels wide. */
  readableSmall: boolean;
  notes: string;
}

const MARK_KEYS = ['graphicalLogoOrIcon', 'badgeSealAwardOrCertification', 'inventedNumberPriceOrStatistic', 'interfaceOrScreenshotWithText', 'personPresentedAsCustomerOrEndorser', 'flagOrReligiousSymbol'] as const;

const MARK_REASON: Readonly<Record<(typeof MARK_KEYS)[number], string>> = {
  graphicalLogoOrIcon: 'it draws a logo, icon or brand mark',
  badgeSealAwardOrCertification: 'it shows a badge, seal, medal or award',
  inventedNumberPriceOrStatistic: 'it shows a number, price or statistic that is not in the approved text',
  interfaceOrScreenshotWithText: 'it shows an interface or screenshot with writing in it',
  personPresentedAsCustomerOrEndorser: 'it shows a person as if they were a real customer or endorser',
  flagOrReligiousSymbol: 'it shows a flag or a religious symbol',
};

const REVIEW_SYSTEM = `You inspect one finished social media poster, only to report what is on it. You do not judge whether the text is right: you transcribe it. Be literal and complete.
1. regions: list EVERY separate piece of visible text on the poster, in reading order, exactly as it appears, including tiny text, text inside illustrations, interface labels, signs, watermarks, web addresses and the brand's name. Do not correct spelling, do not complete cut-off words, do not add words that are not there, do not leave out text because it is small or decorative. A line of a headline that wraps onto several lines is one region. Set "readable" to false for any region you are not sure you read correctly. If there is no text, return an empty list.
2. marks: answer true or false for each question about what is drawn. Be strict about real problems and do not report ordinary illustration as a problem.
   graphicalLogoOrIcon: true ONLY for a logo, emblem, app-icon tile or brand mark that looks like a company's brand identity: a made-up logo, a symbol placed beside or above the brand's name as if it were its logo, a monogram or a crest. FALSE for ordinary illustration elements such as a database, calendar, target, magnifier, chat bubble, document, gear, robot character or person drawn as part of the artwork.
   badgeSealAwardOrCertification: true for a badge, seal, medal, trophy, ribbon, star rating or certification mark.
   inventedNumberPriceOrStatistic: true if a number, price, percentage or rating is shown that is NOT part of the approved text. The approved text is: {ALLOWED}. A number that is part of that text (for example "14-day" in an approved headline) is allowed and is FALSE.
   interfaceOrScreenshotWithText: true ONLY if a screen, app window or chat contains legible words or numbers, or looks like a real screenshot of a product. FALSE for abstract interface drawings made of shapes, bars, lines, dots and icons with no readable words.
   personPresentedAsCustomerOrEndorser: true only if a person is shown with a name, quote, caption or title as a customer, employee or endorser. A generic illustrated person is FALSE.
   flagOrReligiousSymbol: true for a national flag or a religious symbol.
3. relevance 0 to 2: does the artwork clearly communicate this message: "{MESSAGE}". 0 not at all, 1 partly, 2 clearly.
4. composition 0 to 2: is the main text fully inside the frame, not cropped or hidden, and readable against what is directly behind it. The text may be large or small, plain or expressive; judge only whether every letter can be read. 0 no, 1 acceptable, 2 clear.
5. readableSmall: true or false. Imagine the poster shown only 360 pixels wide on a phone. Would the headline, the brand name and the web address all still be readable? False if any of them would become illegible.
6. notes: one short sentence on the biggest problem, or "none".
Return JSON only: {"regions":[{"text":"...","readable":true}],"marks":{"graphicalLogoOrIcon":false,"badgeSealAwardOrCertification":false,"inventedNumberPriceOrStatistic":false,"interfaceOrScreenshotWithText":false,"personPresentedAsCustomerOrEndorser":false,"flagOrReligiousSymbol":false},"relevance":2,"composition":2,"readableSmall":true,"notes":"none"}`;

function parseReview(value: unknown): CreativeReview {
  const raw = value as { regions?: unknown; marks?: Record<string, unknown>; relevance?: unknown; composition?: unknown; readableSmall?: unknown; notes?: unknown };
  if (!Array.isArray(raw.regions)) throw new Error('"regions" must be a list');
  const regions = raw.regions.map((r) => {
    const region = r as { text?: unknown; readable?: unknown };
    if (typeof region.text !== 'string' || typeof region.readable !== 'boolean') throw new Error('every region needs "text" (a string) and "readable" (true or false)');
    return { text: region.text.trim(), readable: region.readable };
  }).filter((r) => r.text !== '');
  const marks = {} as CreativeReview['marks'];
  for (const key of MARK_KEYS) {
    const answer = raw.marks?.[key];
    if (typeof answer !== 'boolean') throw new Error(`marks.${key} must be true or false`);
    marks[key] = answer;
  }
  const score = (name: 'relevance' | 'composition'): number => {
    const v = raw[name];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 2) throw new Error(`"${name}" must be 0, 1 or 2`);
    return v;
  };
  if (typeof raw.readableSmall !== 'boolean') throw new Error('"readableSmall" must be true or false');
  return { regions, marks, relevance: score('relevance'), composition: score('composition'), readableSmall: raw.readableSmall, notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 300) : '' };
}

/** One vision request that transcribes and describes the poster. The decision is not made here (see judgeCreative). A model does not read the same picture the same way every time, so a poster is read more than once and must pass every reading. */
export async function reviewCreative(ai: AiConfig, imagePath: string, message: string, fetchFn?: typeof fetch, reading = 1, allowed: readonly string[] = []): Promise<CreativeReview> {
  const bytes = await readFile(imagePath);
  return chatJson({
    ai,
    ...(fetchFn ? { fetchFn } : {}),
    system: REVIEW_SYSTEM.replace('{MESSAGE}', message.replace(/"/g, "'")).replace('{ALLOWED}', allowed.length > 0 ? allowed.map((a) => `"${a.replace(/"/g, "'")}"`).join(', ') : 'none'),
    user: `Inspect this poster (independent reading ${reading}).`,
    images: [`data:image/jpeg;base64,${bytes.toString('base64')}`],
    parse: parseReview,
  });
}

// ---- The decision, in code

export type CreativeDefect =
  | { kind: 'missing_text'; text: string }
  | { kind: 'repeated_text'; text: string }
  | { kind: 'extra_text'; text: string }
  | { kind: 'unreadable_text'; text: string }
  | { kind: 'forbidden_mark'; mark: keyof CreativeReview['marks']; reason: string }
  | { kind: 'not_relevant' }
  | { kind: 'poor_composition' }
  | { kind: 'illegible_small' };

export interface CreativeVerdict {
  accepted: boolean;
  defects: CreativeDefect[];
}

const normal = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const tokens = (text: string): string[] => normal(text).split(' ').filter(Boolean);

/** The positions where `needle` appears as a run of whole words in `words`, without overlaps. */
function runsOf(words: readonly string[], needle: readonly string[]): number[] {
  const at: number[] = [];
  if (needle.length === 0) return at;
  for (let i = 0; i + needle.length <= words.length; i++) {
    if (needle.every((w, k) => words[i + k] === w)) {
      at.push(i);
      i += needle.length - 1;
    }
  }
  return at;
}

/**
 * Compares what is on the poster with the exact text it may carry. The headline, the web address and a supporting line must each appear exactly once;
 * the brand's name must appear once (the headline may be what names it); nothing else may be readable; any text the reader was unsure of rejects the poster.
 * Only differences of case, accents, spacing and punctuation are ignored.
 */
export function judgeCreative(manifest: TextManifest, review: CreativeReview): CreativeVerdict {
  const defects: CreativeDefect[] = [];
  for (const region of review.regions) if (!region.readable) defects.push({ kind: 'unreadable_text', text: region.text });

  let rest: string[] = tokens(review.regions.map((r) => r.text).join(' '));
  const take = (label: string, text: string, required: boolean, allowedInside: boolean): void => {
    const needle = tokens(text);
    const at = runsOf(rest, needle);
    if (at.length === 0) {
      if (required) defects.push({ kind: 'missing_text', text: label });
      return;
    }
    if (at.length > 1 && !allowedInside) defects.push({ kind: 'repeated_text', text: label });
    // Every occurrence found is removed, so what remains is what was not asked for.
    for (const start of [...at].reverse()) rest = [...rest.slice(0, start), ...rest.slice(start + needle.length)];
  };

  const brandInHeadline = runsOf(tokens(manifest.headline), tokens(manifest.brandName)).length > 0;
  // The longest texts go first: the address and the headline can contain the brand's name.
  take('the headline', manifest.headline, true, false);
  if (manifest.subline) take('the supporting line', manifest.subline, true, false);
  take('the web address', manifest.domain, true, false);
  take('the brand name', manifest.brandName, !brandInHeadline, brandInHeadline);

  if (rest.length > 0) defects.push({ kind: 'extra_text', text: rest.join(' ') });
  for (const key of MARK_KEYS) if (review.marks[key]) defects.push({ kind: 'forbidden_mark', mark: key, reason: MARK_REASON[key] });
  if (review.relevance < 1) defects.push({ kind: 'not_relevant' });
  if (review.composition < 1) defects.push({ kind: 'poor_composition' });
  if (!review.readableSmall) defects.push({ kind: 'illegible_small' });
  return { accepted: defects.length === 0, defects };
}

/** What a rejected poster's defects say, as an instruction for the next attempt. */
export function retryNoteFor(defects: readonly CreativeDefect[]): string {
  const parts = defects.map((d): string => {
    switch (d.kind) {
      case 'missing_text': return `${d.text} was missing or misspelled.`;
      case 'repeated_text': return `${d.text} appeared more than once.`;
      case 'extra_text': return `it showed text that is not allowed ("${d.text}"); show no other text at all, not even small or decorative.`;
      case 'unreadable_text': return `some text was unreadable ("${d.text}"); keep every allowed text large, sharp and clear.`;
      case 'forbidden_mark': return `${d.reason}; leave it out.`;
      case 'not_relevant': return 'the artwork did not communicate the message; make the idea more direct.';
      case 'poor_composition': return 'the headline was hard to read or cut off; make it larger with clear margins and strong contrast.';
      case 'illegible_small': return 'the text would not be readable at a small size; make the headline, the brand name and the web address larger and higher in contrast against what is behind them.';
    }
  });
  return [...new Set(parts)].join(' ');
}

/** True when a new instruction can fix the defects: every defect here is about what the picture shows, so a retry is allowed for all of them. */
export const isRecoverable = (defects: readonly CreativeDefect[]): boolean => defects.length > 0;

/** The verdict over several independent readings of one poster: it is accepted only if every reading accepts it, and every defect any reading found is kept. */
export function judgeReadings(manifest: TextManifest, readings: readonly CreativeReview[]): CreativeVerdict {
  const seen = new Set<string>();
  const defects: CreativeDefect[] = [];
  for (const reading of readings) {
    for (const defect of judgeCreative(manifest, reading).defects) {
      const key = JSON.stringify(defect);
      if (!seen.has(key)) {
        seen.add(key);
        defects.push(defect);
      }
    }
  }
  return { accepted: readings.length > 0 && defects.length === 0, defects };
}
