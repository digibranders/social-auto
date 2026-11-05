import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPicturePolicy, defaultPicturePolicy } from './picture-policy.ts';

test('an ordinary scene passes, including people', () => {
  const result = checkPicturePolicy(['a bright workspace with two colleagues talking', 'three-quarter view', 'warm and calm']);
  assert.deepEqual(result, { violations: [], warnings: [] });
});

test('requests for baked-in text, numbers, logos, credentials, interfaces and real places are held back', () => {
  const cases: Array<[string, string]> = [
    ['a poster with the words SAVE TIME on it', 'baked_in_text'],
    ['a big 40% banner behind the subject', 'numbers_and_metrics'],
    ['the company logo glowing on the wall', 'logos_and_marks'],
    ['a gold award trophy on a shelf', 'credentials_and_awards'],
    ['a laptop showing a screenshot of the app', 'product_interface'],
    ['our office building at sunrise', 'real_places_and_people'],
  ];
  for (const [text, category] of cases) assert.deepEqual(checkPicturePolicy([text]).violations, [category], text);
});

test('words only count as whole words, so ordinary language is not caught', () => {
  assert.deepEqual(checkPicturePolicy(['a context of teamwork, contextual light']).violations, []);
  assert.deepEqual(checkPicturePolicy(['a quiet building']).violations, []);
});

test('approved material lifts a category, and only that one', () => {
  const screen = ['a laptop showing a screenshot of the app'];
  assert.deepEqual(checkPicturePolicy(screen, { productAsset: true }).violations, []);
  assert.deepEqual(checkPicturePolicy(['a gold award trophy'], { productAsset: true }).violations, ['credentials_and_awards']);
  assert.deepEqual(checkPicturePolicy(['a gold award trophy'], { credential: true }).violations, []);
});

test('several categories are all reported, in policy order', () => {
  assert.deepEqual(checkPicturePolicy(['a logo and the text 50% off']).violations, ['baked_in_text', 'numbers_and_metrics', 'logos_and_marks']);
});

test('non-Latin text is not silently passed: the numbers check still applies and a warning says the word lists did not', () => {
  const result = checkPicturePolicy(['एक शांत कार्यालय']);
  assert.deepEqual(result.violations, []);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(checkPicturePolicy(['एक शांत कार्यालय 40']).violations, ['numbers_and_metrics']);
});

test('the policy names no industry', () => {
  const text = JSON.stringify(defaultPicturePolicy).toLowerCase();
  for (const word of ['clinic', 'patient', 'bank', 'restaurant', 'dental', 'hotel']) assert.ok(!text.includes(word), word);
});

test('a tenant can replace the policy', () => {
  const custom = [{ id: 'no_cats', terms: ['cat'] }];
  assert.deepEqual(checkPicturePolicy(['a cat on a sofa'], {}, custom).violations, ['no_cats']);
  assert.deepEqual(checkPicturePolicy(['a logo'], {}, custom).violations, []);
});
