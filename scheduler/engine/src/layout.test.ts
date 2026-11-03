import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAYOUTS, parseWeekPlan, type Brand, type PlannedPost } from './content.ts';
import { compositionFor, layoutFor, lighten, renderPostHtml, visualStyleFor } from './layout.ts';
import { resolveImageModel } from './pollinations.ts';

const brand: Brand = {
  name: 'Brandbasket',
  website: 'brandbasket.in',
  handleUrl: 'brandbasket.in',
  offer: 'o',
  audience: 'a',
  tone: 't',
  proofPoints: ['p'],
  callToAction: 'c',
  rules: ['r'],
  colors: { background: '#F7F1E8', ink: '#15161A', accent: '#B07D3C', tile: '#F3E2CC' },
  font: 'Red Hat Display',
  logo: 'logo.svg',
  mark: 'm',
  features: [{ icon: 'monitor', title: 'Free website', detail: 'Up to 10 pages' }],
};
const post: PlannedPost = {
  id: 'w01-d1',
  date: '2026-11-09T10:00:00+05:30',
  painPoint: 'pain',
  mode: 'ai',
  headline: 'Hard to explain |what you need|?',
  subline: 'sub',
  imagePrompt: 'a shopkeeper',
  caption: 'Body',
  hashtags: ['#one'],
};
const html = (layout?: PlannedPost['layout']): string =>
  renderPostHtml({ brand, post: layout ? { ...post, layout } : post, painPointNumber: 1, logoHtml: '<svg></svg>', visualUrl: 'file:///x.jpg' });

test('layoutFor never repeats a layout on neighbouring posts, within a week or across weeks, and uses all layouts', () => {
  for (let week = 1; week <= 20; week++) {
    const sequence = Array.from({ length: 7 }, (_, i) => layoutFor(week, i));
    assert.equal(new Set(sequence).size, LAYOUTS.length, `week ${week} uses every layout`);
    sequence.slice(1).forEach((layout, i) => assert.notEqual(layout, sequence[i], `week ${week}, posts ${i + 1} and ${i + 2}`));
    assert.notEqual(layoutFor(week + 1, 0), layoutFor(week, 6), `week ${week} to ${week + 1}`);
  }
});

test('each layout asks the picture for room where that layout puts its text', () => {
  assert.match(compositionFor('left'), /right 40%.*left 60%.*empty/);
  assert.match(compositionFor('right'), /left 40%.*right 60%.*empty/);
  assert.match(compositionFor('bottom'), /upper 45%.*lower 55%.*empty/);
  assert.match(compositionFor('dark'), /upper two thirds.*lower third/);
  for (const layout of LAYOUTS) assert.match(visualStyleFor(layout), /no text, no letters, no words, no logos/);
});

test('every layout renders the headline, the sub line and the feature bar, and marks itself', () => {
  for (const layout of LAYOUTS) {
    const page = html(layout);
    assert.match(page, new RegExp(`<body class="layout-${layout}">`));
    assert.ok(page.includes('what you need') && page.includes('class="sub"') && page.includes('Free website'), layout);
  }
});

test('a post without a layout renders as the original left layout', () => {
  assert.equal(html(), html('left'));
});

test('the dark layout uses light text', () => {
  assert.match(html('dark'), /\.layout-dark h1 \{ color: #fff/);
});

test('layouts whose logo sits over the photo give it a backing that grows with the logo, not a fixed height', () => {
  for (const layout of ['bottom', 'dark'] as const) {
    assert.match(html(layout), new RegExp(`\\.layout-${layout} \\.logo \\{[^}]*height: auto[^}]*background`), layout);
  }
});

test('lighten moves a colour towards white', () => {
  assert.equal(lighten('#000000', 0.5), '#808080');
  assert.equal(lighten('#ffffff', 0.5), '#ffffff');
});

test('a plan keeps a valid layout and rejects an unknown one', () => {
  const raw = (layout: unknown) => ({ brand: 'b', timezone: '+05:30', posts: [{ ...post, layout }] });
  assert.equal(parseWeekPlan(raw('dark'), 't').posts[0]?.layout, 'dark');
  assert.equal(parseWeekPlan({ brand: 'b', timezone: '+05:30', posts: [post] }, 't').posts[0]?.layout, undefined);
  assert.throws(() => parseWeekPlan(raw('diagonal'), 't'), /layout/);
});

test('resolveImageModel takes the flag, then POLLINATIONS_IMAGE_MODEL, then the free default', () => {
  assert.equal(resolveImageModel('openai/gpt-image-2.5-flare', { POLLINATIONS_IMAGE_MODEL: 'x' }), 'openai/gpt-image-2.5-flare');
  assert.equal(resolveImageModel(undefined, { POLLINATIONS_IMAGE_MODEL: 'openai/gpt-image-2.5-flare' }), 'openai/gpt-image-2.5-flare');
  assert.equal(resolveImageModel(undefined, {}), 'zimage');
  assert.equal(resolveImageModel(undefined, { POLLINATIONS_IMAGE_MODEL: '' }), 'zimage');
});
