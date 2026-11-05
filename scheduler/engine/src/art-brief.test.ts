import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArtDirectionError, parseArtBrief, type ArtBrief } from './art-brief.ts';

const brief = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  layout: 'split-composition',
  hierarchy: 'headline-first',
  headlineScale: 'large',
  alignment: 'start',
  textZone: 'left',
  picture: {
    role: 'hero',
    medium: 'illustration',
    subject: 'a project dashboard',
    action: 'highlighting overdue work',
    scene: 'a quiet modern workspace',
    composition: 'close-up from the front',
    mood: 'calm and focused',
    paletteUse: 'balanced',
  },
  logoSlot: 'top-left',
  identitySlot: 'under-logo',
  ctaSlot: 'top-right',
  ...over,
});

const problemOf = (raw: unknown): string => {
  try {
    parseArtBrief(raw, 'post 1');
  } catch (error) {
    assert.ok(error instanceof ArtDirectionError, String(error));
    return error.message;
  }
  return '';
};

test('a complete brief parses into typed fields', () => {
  const parsed: ArtBrief = parseArtBrief(brief(), 'post 1');
  assert.equal(parsed.layout, 'split-composition');
  assert.equal(parsed.picture.role, 'hero');
  assert.equal(parsed.picture.medium, 'illustration');
  assert.equal(parsed.picture.subject, 'a project dashboard');
  assert.equal(parsed.ctaSlot, 'top-right');
});

test('text fields are trimmed and a brief that is not an object is refused', () => {
  const parsed = parseArtBrief(brief({ picture: { ...(brief()['picture'] as object), subject: '  a dashboard  ' } }), 'post 1');
  assert.ok(parsed.picture.role !== 'none');
  assert.equal(parsed.picture.subject, 'a dashboard');
  assert.match(problemOf('split'), /post 1: .*object/);
  assert.match(problemOf(null), /object/);
  assert.match(problemOf([brief()]), /object/);
});

test('an unknown enum value names the field and the allowed values', () => {
  for (const [field, value] of [
    ['hierarchy', 'centered'],
    ['headlineScale', 'huge'],
    ['alignment', 'justify'],
    ['textZone', 'diagonal'],
  ] as const) {
    const message = problemOf(brief({ [field]: value }));
    assert.match(message, new RegExp(`"${field}" must be one of`), message);
  }
  assert.match(problemOf(brief({ picture: { ...(brief()['picture'] as object), medium: 'oil painting' } })), /"picture.medium" must be one of/);
  assert.match(problemOf(brief({ picture: { ...(brief()['picture'] as object), role: 'background' } })), /"picture.role" must be one of/);
  assert.match(problemOf(brief({ picture: { ...(brief()['picture'] as object), paletteUse: 'rainbow' } })), /"picture.paletteUse" must be one of/);
});

test('missing or empty required fields are refused', () => {
  for (const field of ['layout', 'hierarchy', 'headlineScale', 'alignment', 'textZone', 'logoSlot', 'identitySlot', 'ctaSlot', 'picture']) {
    const raw = brief();
    delete raw[field];
    assert.match(problemOf(raw), new RegExp(`"${field}"`), field);
  }
  assert.match(problemOf(brief({ layout: '   ' })), /"layout"/);
});

test('a picture role other than none needs every picture field', () => {
  for (const field of ['medium', 'subject', 'action', 'scene', 'composition', 'mood', 'paletteUse']) {
    const picture = { ...(brief()['picture'] as Record<string, unknown>) };
    delete picture[field];
    assert.match(problemOf(brief({ picture })), new RegExp(`"picture.${field}"`), field);
  }
});

test('picture role none carries no picture direction, so no image can be requested', () => {
  const parsed = parseArtBrief(brief({ picture: { role: 'none', subject: 'ignored', medium: 'illustration' } }), 'post 1');
  assert.deepEqual(parsed.picture, { role: 'none' });
});

test('picture text fields are bounded', () => {
  const long = 'x'.repeat(161);
  assert.match(problemOf(brief({ picture: { ...(brief()['picture'] as object), subject: long } })), /"picture.subject" is longer than 160/);
});

test('the brief cannot carry colours, coordinates, accent words or copy: those are code or approved copy', () => {
  const parsed = parseArtBrief(
    brief({ colors: ['#ff0000'], x: 10, accentWords: ['free'], headline: 'rewritten', css: 'color: red' }),
    'post 1',
  ) as unknown as Record<string, unknown>;
  for (const key of ['colors', 'x', 'accentWords', 'headline', 'css']) assert.equal(parsed[key], undefined, key);
});

import { clipToLimit } from './art-brief.ts';

test('clipToLimit keeps short text, cuts long text at a word and drops trailing punctuation', () => {
  assert.equal(clipToLimit('  short text  '), 'short text');
  const long = `${'word '.repeat(60)}end`;
  const clipped = clipToLimit(long);
  assert.ok(clipped.length <= 160);
  assert.ok(!clipped.endsWith(' '));
  assert.ok(clipped.split(' ').every((w) => w === 'word'));
  assert.equal(clipToLimit('alpha, beta, gamma, delta', 12), 'alpha, beta');
});
