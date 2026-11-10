import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitTrailingHashtags, tidyPunctuation } from './caption-text.ts';

test('two full stops become one, an ellipsis stays', () => {
  assert.equal(tidyPunctuation('A real AI agent..'), 'A real AI agent.');
  assert.equal(tidyPunctuation('Wait... go.. now'), 'Wait... go. now');
});

test('no full stop follows the closing "(link in bio)"', () => {
  assert.equal(tidyPunctuation('Hook.\n\nVisit acme.com (link in bio).'), 'Hook.\n\nVisit acme.com (link in bio)');
  assert.equal(tidyPunctuation('Visit acme.com (link in bio)'), 'Visit acme.com (link in bio)');
});

test('closing hashtag paragraphs are split from the words, and a caption of only tags keeps its text', () => {
  assert.deepEqual(splitTrailingHashtags('Words here.\n\nVisit acme.com\n\n#One #Two'), { body: 'Words here.\n\nVisit acme.com', hashtags: ['#One', '#Two'] });
  assert.deepEqual(splitTrailingHashtags('Words.\n\n#A\n\n#B #C'), { body: 'Words.', hashtags: ['#A', '#B', '#C'] });
  assert.deepEqual(splitTrailingHashtags('No tags at all.'), { body: 'No tags at all.', hashtags: [] });
  assert.deepEqual(splitTrailingHashtags('#OnlyTags'), { body: '#OnlyTags', hashtags: [] });
  assert.deepEqual(splitTrailingHashtags('A #hashtag inside the words stays.'), { body: 'A #hashtag inside the words stays.', hashtags: [] });
});
