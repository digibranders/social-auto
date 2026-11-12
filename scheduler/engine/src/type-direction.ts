/**
 * Headline typography as art direction, not a menu. The picture model is asked to invent an original typographic voice for each headline from its meaning, the
 * mood of the topic and the brand's look, and to choose the composition, scale, line breaks and alignment itself. There is no list of styles and no style is
 * assigned to a network. Two things keep the pictures of one topic from looking alike without forcing anything:
 *
 *   - a vocabulary of independent traits (weight, character, contrast, rhythm, treatment) given as inspiration, never as a combination the model must use;
 *   - a gentle "lean" (a weight and a character) that differs for every network of one topic and follows from the post, so a redraw keeps it. The model may
 *     ignore the lean when the headline calls for something else.
 *
 * Each brand remembers the leans of its recent pictures, and a new lean steers clear of them, so a brand's posters do not settle into one look.
 * Nothing here can make the model spell a headline right: the poster is still read back and judged after it is drawn.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NETWORKS, type Network } from './networks.ts';

export const TRAITS = {
  weight: ['delicate', 'regular', 'bold', 'heavy', 'extreme'],
  character: ['geometric', 'humanist', 'calligraphic', 'irregular and hand-made', 'mechanical'],
  contrast: ['uniform', 'moderate', 'dramatic'],
  width: ['compressed', 'natural', 'expanded'],
  rhythm: ['disciplined', 'energetic', 'playful', 'restrained'],
  treatment: ['clean', 'tactile', 'inked', 'dimensional'],
} as const;

/** The two traits a picture is gently nudged towards. The model may go elsewhere. */
export interface TypeLean {
  weight: string;
  character: string;
}

const same = (a: TypeLean, b: TypeLean): boolean => a.weight === b.weight && a.character === b.character;

/** A small stable number from text, so the same post always gets the same lean. */
function spread(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return h;
}

/** A stable shuffle of a list, from a seed. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = Math.imul(state, 1664525) + 1013904223 >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * The lean of a post's picture for a network. The four networks of one post get four different weights and four different characters (the post decides the order),
 * and the lean steers clear of the brand's recent ones: when it would repeat one, the next candidate in the post's order is taken (the same one every time).
 */
export function leanFor(postId: string, network: Network, recent: readonly TypeLean[] = []): TypeLean {
  const at = NETWORKS.indexOf(network);
  const weights = shuffled(TRAITS.weight, spread(`${postId}|weight`));
  const characters = shuffled(TRAITS.character, spread(`${postId}|character`));
  // Candidates in the post's own order: this network's pair first, then the pairs the other positions would give.
  for (let step = 0; step < weights.length; step += 1) {
    const lean = { weight: weights[(at + step * NETWORKS.length) % weights.length] as string, character: characters[(at + step) % characters.length] as string };
    if (!recent.some((r) => same(r, lean))) return lean;
  }
  return { weight: weights[at % weights.length] as string, character: characters[at % characters.length] as string };
}

/** Headline typography is on unless HEADLINE_STYLES_ENABLED is exactly "false". */
export const headlineStylesEnabled = (env: Record<string, string | undefined>): boolean => env['HEADLINE_STYLES_ENABLED'] !== 'false';

const NETWORK_CONTEXT: Record<Network, string> = {
  instagram: 'It is seen in a fast, visual feed.',
  facebook: 'It is seen in a friendly, conversational feed.',
  linkedin: 'It is seen by a business reader: it should feel credible and considered, not dull.',
  google: 'It is seen next to a local business listing: it should feel plain, clear and trustworthy, not flat.',
};

/** The prompt text for a picture's headline typography. It asks for an original voice and leaves every layout decision to the picture model. */
export function typeDirectionLine(input: { network: Network; lean: TypeLean }): string {
  const ingredients = Object.entries(TRAITS).map(([name, values]) => `${name}: ${values.join(', ')}`).join('; ');
  return [
    'TYPOGRAPHIC VOICE. Invent an original typographic voice for this headline from its meaning, the mood of the topic and the brand\'s look. Decide what attitude the words should carry and let the lettering express it.',
    `Traits for inspiration only, to use, combine or go beyond (${ingredients}).`,
    `This version leans towards ${input.lean.weight} weight and a ${input.lean.character} character, but only where that serves this headline; follow the words rather than the lean when they ask for something else. The other pictures of this topic lean elsewhere, so make this one clearly its own. ${NETWORK_CONTEXT[input.network]}`,
    'You choose the composition, scale, line breaks, alignment and placement yourself, and do not copy a stock poster arrangement. Every letter must be exactly as given and easy to read at phone size; clear letters matter more than the effect. A script or handwritten style may be used only for one short accent word, never for the whole headline.',
  ].join(' ');
}

// ---- A brand's memory of recent leans

const HISTORY_KEEP = 20;
const HISTORY_FILE = 'type-history.json';

export interface LeanRecord extends TypeLean {
  at: string;
  postId: string;
  network: string;
}

export async function loadTypeHistory(brandDir: string): Promise<LeanRecord[]> {
  try {
    const raw = JSON.parse(await readFile(join(brandDir, HISTORY_FILE), 'utf8')) as { leans?: unknown };
    return Array.isArray(raw.leans) ? (raw.leans as LeanRecord[]).filter((r) => typeof r.weight === 'string' && typeof r.character === 'string') : [];
  } catch {
    return [];
  }
}

/** Adds the leans of this run to the brand's memory (newest first, the last 20 kept). */
export async function saveTypeHistory(brandDir: string, existing: readonly LeanRecord[], added: readonly LeanRecord[]): Promise<void> {
  if (added.length === 0) return;
  const file = join(brandDir, HISTORY_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, `${JSON.stringify({ leans: [...added, ...existing].slice(0, HISTORY_KEEP) }, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}
