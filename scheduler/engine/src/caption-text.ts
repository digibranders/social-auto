/** Small rules about caption text, kept apart so the places that compose captions can all use them. */

/** A sentence that ends in two full stops (the writer's full stop plus one added when the closing line was joined on) ends in one; an ellipsis ("...") is left alone. */
export const tidyPunctuation = (text: string): string => text.replace(/(?<![.…])\.{2}(?![.…])/g, '.');

const ONLY_TAGS = /^(?:#[^\s#]+\s*)+$/;

/** A caption's own words and the hashtags that close it: trailing paragraphs made only of #tags are the hashtags, everything before them the words. */
export function splitTrailingHashtags(text: string): { body: string; hashtags: string[] } {
  const paragraphs = text.trim().split(/\n{2,}/);
  const tags: string[] = [];
  while (paragraphs.length > 1 && ONLY_TAGS.test((paragraphs.at(-1) as string).trim())) tags.unshift(...(paragraphs.pop() as string).trim().split(/\s+/));
  return { body: paragraphs.join('\n\n').trim(), hashtags: tags };
}
