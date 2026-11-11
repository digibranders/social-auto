import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionTarget } from './planner.ts';
import { captionRulesView, composeVariant, NETWORK_RULES, NETWORKS, pictureGroups, recommendedLengthText, SQUARE_SHAPE, variantTexts, type PostVariants } from './networks.ts';

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

test('each network has a length worth aiming for inside its limit, a cut-off inside that, and the page is told all of it', () => {
  for (const network of NETWORKS) {
    const r = NETWORK_RULES[network];
    assert.ok(r.recommended.min > 0 && r.recommended.min < r.recommended.max, `${network}: a range`);
    assert.ok(r.recommended.max <= r.maxCaption, `${network}: aim for less than the most`);
    assert.ok(r.visibleChars > 0 && r.visibleChars < r.recommended.max, `${network}: what is seen first is shorter than the whole`);
  }
  assert.equal(recommendedLengthText('instagram'), 'about 100 to 300 characters');
  assert.equal(recommendedLengthText('linkedin'), 'about 400 to 800 characters');
  // The shorter channels are held to a shorter most than LinkedIn.
  assert.ok(NETWORK_RULES.instagram.maxCaption < NETWORK_RULES.linkedin.maxCaption);
  assert.deepEqual(captionRulesView().google, { maxCaption: 1000, recommendedMin: 150, recommendedMax: 300, visibleChars: 100, maxHashtags: 0 });
  assert.deepEqual(Object.keys(captionRulesView()), [...NETWORKS]);
});

test('the main caption, which is Instagram\'s, is asked for inside the range worth aiming for on Instagram', () => {
  const { min, max } = NETWORK_RULES.instagram.recommended;
  for (const facts of [1, 2, 3]) {
    const [low, high] = (/(\d+) to (\d+)/.exec(captionTarget(facts)) ?? []).slice(1).map(Number) as [number, number];
    assert.ok(low >= min && high <= max, `${facts} fact(s): ${captionTarget(facts)} is inside ${min} to ${max}`);
  }
});
