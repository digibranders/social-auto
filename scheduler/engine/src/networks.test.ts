import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeVariant, NETWORK_RULES, pictureGroups, SQUARE_SHAPE, variantTexts, type PostVariants } from './networks.ts';

const v = (caption: string, hashtags: string[] = []) => ({ caption, hashtags });

test('networks of the same shape share one picture: square first, a wide one added for LinkedIn', () => {
  const posts = [
    { id: 'p1', variants: { instagram: v('a'), facebook: v('b'), linkedin: v('c'), google: v('d') } as PostVariants },
    { id: 'p2', variants: { linkedin: v('only linkedin') } as PostVariants },
    { id: 'p3', variants: { instagram: v('only instagram') } as PostVariants },
  ];
  const groups = pictureGroups(posts);
  assert.deepEqual(groups.map((g) => g.shape.shape), ['square', 'wide']);
  assert.deepEqual(groups[0]?.networks.sort(), ['facebook', 'google', 'instagram']);
  assert.deepEqual(groups[0]?.postIds.sort(), ['p1', 'p3'], 'p2 has no square network, so no square picture');
  assert.deepEqual(groups[1]?.networks, ['linkedin']);
  assert.deepEqual(groups[1]?.postIds.sort(), ['p1', 'p2']);
  assert.deepEqual(groups[1]?.shape, NETWORK_RULES.linkedin.picture);
});

test('a post with no network captions needs the square picture only, as before networks existed', () => {
  const groups = pictureGroups([{ id: 'p1' }, { id: 'p2', variants: {} }]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]?.shape, SQUARE_SHAPE);
  assert.deepEqual(groups[0]?.networks, []);
  assert.deepEqual(groups[0]?.postIds, ['p1', 'p2']);
  assert.deepEqual(pictureGroups([]), []);
});

test('a network caption is its words, then its hashtags; a network with none shows no hashtag line', () => {
  assert.equal(composeVariant(v('Words.', ['#a', '#b'])), 'Words.\n\n#a #b');
  assert.equal(composeVariant(v('Words.')), 'Words.');
  assert.equal(variantTexts({}), undefined);
  assert.deepEqual(variantTexts({ variants: { google: v('Plain.') } }), { google: 'Plain.' });
});
