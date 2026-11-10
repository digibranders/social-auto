/**
 * Plain-writing checks on a post's headline and caption, before any picture is paid for. The claim gate (copy-gate.ts) asks "is it supported by the
 * site?"; this asks "does it say anything, in a way a person would post?". It judges shape only, never industry words:
 *
 *   - a headline of fewer than three words says nothing;
 *   - a headline that is a name or a quote credit ("- HENRY FORD -") is not a message;
 *   - a caption that says the same thing twice, or echoes the headline in two more sentences, is padding.
 *
 * It returns a sentence written so the model can fix the post on its next try, or undefined when the copy is fine.
 */
import type { PostCopy } from './copy-gate.ts';

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'be', 'it', 'its', 'your', 'you', 'our', 'we', 'can', 'could', 'will', 'would', 'that', 'this', 'at', 'by', 'from', 'as', 'how', 'what']);
const MIN_HEADLINE_WORDS = 3;
const ECHO = 0.75;
const MIN_STEMS = 3;

const plain = (text: string): string => text.replaceAll('|', '').replace(/\s+/g, ' ').trim();
const words = (text: string): string[] => plain(text).split(/[^\p{L}\p{N}']+/u).filter((w) => w !== '');
/** Content words reduced to their first five letters, so "amplified" and "amplify" count as the same word. */
const stems = (text: string): Set<string> => new Set(words(text).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w) && w.length > 2).map((w) => w.slice(0, 5)));

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size < MIN_STEMS || b.size < MIN_STEMS) return 0;
  let shared = 0;
  for (const stem of a) if (b.has(stem)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** The sentences of the caption that are the post's own words: no hashtags, no web address or link-in-bio line. */
function captionSentences(caption: string): string[] {
  return caption
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !/https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\b|link in bio/i.test(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

export function checkCopyQuality(copy: Pick<PostCopy, 'headline' | 'caption'>): string | undefined {
  const headline = plain(copy.headline);
  // A name or credit set between dashes ("- HENRY FORD -", "— Jane Doe") is a signature, not a message.
  if (/^[-–—~•\s]/.test(headline) || /[-–—~•\s]$/.test(headline)) return `headline "${headline}" looks like a name or a quote credit; write a sentence that says something about the business`;
  if (words(headline).length < MIN_HEADLINE_WORDS) return `headline "${headline}" is too short to say anything; write a headline of at least ${MIN_HEADLINE_WORDS} words that states one idea`;

  const sentences = captionSentences(copy.caption);
  const own = stems(headline);
  const parts = sentences.map(stems);
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (overlap(parts[i] as Set<string>, parts[j] as Set<string>) >= ECHO) return `the caption says the same thing twice ("${sentences[i]}" and "${sentences[j]}"); say it once and add something new`;
    }
  }
  const echoes = parts.filter((p) => overlap(own, p) >= ECHO).length;
  if (echoes >= 2) return `the caption repeats the headline in ${echoes} sentences; open with what the headline promises, then add a different detail`;
  return undefined;
}
