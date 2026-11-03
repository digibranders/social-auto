import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWeekPlan, type Brand, type PlannedPost } from './content.ts';
import { creativePrompt, formatFor, renderCreativePostHtml } from './creative.ts';
import { FORMATS } from './content.ts';
import { buildPost } from './planner.ts';

const brand = {
  name: 'Acme', colors: { background: '#FCFBF9', ink: '#102234', accent: '#E9AF88', tile: '#0C1E2E' }, font: 'Inter', features: [],
  visualStyle: 'Polished, human-centered imagery of B2B teams in modern offices',
} as unknown as Brand;

const post = (format: PlannedPost['format'], extra: Partial<PlannedPost> = {}): PlannedPost => ({
  id: 'w01-d1', date: '2026-11-04T10:00:00+05:30', painPoint: 'p', mode: format === 'type' ? 'template' : 'ai', format,
  headline: 'Can visitors find the |next step|?', subline: 'Make the next step obvious.', caption: 'c', hashtags: ['#a'], ...extra,
});

test('formats never repeat on neighbouring posts, within a week or across weeks, and every format shows up in a week', () => {
  for (let week = 1; week <= 12; week++) {
    const formats = Array.from({ length: 7 }, (_, i) => formatFor(week, i));
    for (let i = 1; i < formats.length; i++) assert.notEqual(formats[i], formats[i - 1], `week ${week} post ${i}`);
    assert.deepEqual([...new Set(formats)].sort(), [...FORMATS].sort());
    assert.notEqual(formatFor(week + 1, 0), formats[6], `week ${week} into ${week + 1}`);
  }
});

test('a picture prompt asks for the idea as an object, in the brand\'s colours, with no text, and ignores a people-centred style line', () => {
  for (const format of ['illustration', 'still-life', 'isometric'] as const) {
    const prompt = creativePrompt(format, 'A tangled knot of cables that unravels into one clean line.', brand);
    assert.match(prompt, /tangled knot of cables/);
    assert.match(prompt, /#102234/);
    assert.match(prompt, /#E9AF88/);
    assert.match(prompt, /no text, no letters, no words, no logos/i);
    assert.match(prompt, /no people/i);
    assert.doesNotMatch(prompt, /human-centered|offices|photography, realistic, shallow depth/);
  }
  assert.notEqual(creativePrompt('illustration', 'x', brand), creativePrompt('isometric', 'x', brand));
});

test('a type-only post needs no picture, the others get a prompt', () => {
  const draft = { painPoint: 'p', headline: 'h', subline: 's', visual: 'A signpost.', caption: 'c', hashtags: ['#a'] };
  const typed = buildPost({ draft, id: 'w01-d1', date: '2026-11-04T10:00:00+05:30', weekNumber: 1, index: 0, brand });
  const others = [1, 2, 3].map((index) => buildPost({ draft, id: `w01-d${index + 1}`, date: '2026-11-04T10:00:00+05:30', weekNumber: 1, index, brand }));
  const formats = [typed, ...others].map((p) => p.format);
  assert.deepEqual([...new Set(formats)].sort(), [...FORMATS].sort());
  for (const p of [typed, ...others]) {
    if (p.format === 'type') assert.deepEqual([p.mode, p.imagePrompt], ['template', undefined]);
    else assert.deepEqual([p.mode, typeof p.imagePrompt], ['ai', 'string']);
  }
});

test('a plan keeps a valid format and rejects an unknown one; an old plan without one is still fine', () => {
  const raw = (extra: Record<string, unknown>) => ({ brand: 'a', timezone: '+05:30', posts: [{ ...post('type'), ...extra }] });
  assert.equal(parseWeekPlan(raw({}), 'w').posts[0]?.format, 'type');
  assert.throws(() => parseWeekPlan(raw({ format: 'collage' }), 'w'), /format/);
  const { format: _omit, ...old } = post('type');
  assert.equal(parseWeekPlan({ brand: 'a', timezone: '+05:30', posts: [old] }, 'w').posts[0]?.format, undefined);
});

test('creative posters have no pain-point pill and no service bar, and show the headline with its accent', () => {
  for (const format of FORMATS) {
    const html = renderCreativePostHtml({ brand, post: post(format), painPointNumber: 1, logoHtml: '<svg></svg>', visualUrl: 'file:///x.jpg' });
    assert.match(html, /Can visitors find the <span class="accent">next step<\/span>\?/);
    assert.match(html, /Make the next step obvious\./);
    assert.doesNotMatch(html, /Pain point|class="bar"/);
    assert.match(html, new RegExp(`format-${format}`));
  }
});

test('pictures are used where the format has one, and a type-only poster ignores any', () => {
  const withPicture = (format: PlannedPost['format']) => renderCreativePostHtml({ brand, post: post(format), painPointNumber: 1, logoHtml: '', visualUrl: 'file:///x.jpg' });
  assert.match(withPicture('illustration'), /file:\/\/\/x\.jpg/);
  assert.match(withPicture('still-life'), /file:\/\/\/x\.jpg/);
  assert.match(withPicture('isometric'), /file:\/\/\/x\.jpg/);
  assert.doesNotMatch(withPicture('type'), /x\.jpg/);
});

test('text from the model is escaped, and the logo sits on a light plate so it shows on dark posters', () => {
  const html = renderCreativePostHtml({ brand, post: post('type', { headline: 'A <b>bold</b> |claim|', subline: '5 > 3 & "quotes"' }), painPointNumber: 1, logoHtml: '<svg></svg>' });
  assert.ok(!html.includes('<b>bold</b>'));
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'));
  assert.match(html, /\.logo \{[^}]*background/);
});
