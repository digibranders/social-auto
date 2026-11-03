import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWeekPlan, type Brand, type PlannedPost } from './content.ts';
import { creativePrompt, formatFor, renderCreativePostHtml } from './creative.ts';
import { FORMATS } from './content.ts';
import { buildPost, userPrompt, validateDraft } from './planner.ts';

const brand = {
  name: 'Acme Dental', colors: { background: '#FCFBF9', ink: '#102234', accent: '#E9AF88', tile: '#0C1E2E' }, font: 'Inter', features: [],
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
  const draft = { painPoint: 'p', headline: 'h', subline: 's', visual: 'A signpost.', visualLink: 'A signpost stands for the next step.', caption: 'c', hashtags: ['#a'] };
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

const logoRule = (format: PlannedPost['format'], logoTone?: { pale: number; dark: number } | null): string =>
  renderCreativePostHtml({ brand, post: post(format), painPointNumber: 1, logoHtml: '<svg></svg>', visualUrl: 'file:///x.jpg', logoTone }).match(/\.logo \{[^}]*\}/)?.[0] ?? '';

test('on a picture poster a mostly pale logo gets a dark plate, a dark, mixed or unmeasured one the light plate', () => {
  for (const format of ['illustration', 'still-life', 'isometric'] as const) {
    assert.match(logoRule(format, { pale: 1, dark: 0 }), /background: #14161C/);
    assert.doesNotMatch(logoRule(format, { pale: 0, dark: 1 }), /#14161C|background: none/);
    assert.equal(logoRule(format, { pale: 0.2, dark: 0.4 }), logoRule(format, undefined));
    assert.equal(logoRule(format, null), logoRule(format, undefined));
  }
});

test('on a type-only poster a pale logo sits straight on the dark background with no plate; any other logo keeps a light plate', () => {
  assert.match(logoRule('type', { pale: 1, dark: 0 }), /background: none/);
  assert.doesNotMatch(logoRule('type', { pale: 1, dark: 0 }), /padding|box-shadow/);
  for (const tone of [{ pale: 0, dark: 1 }, { pale: 0.2, dark: 0.4 }, null, undefined]) {
    assert.doesNotMatch(logoRule('type', tone), /background: none|#14161C/);
    assert.match(logoRule('type', tone), /background: #[0-9A-Fa-f]{6}/);
  }
});

const goodDraft = { painPoint: 'p', headline: 'Big files, |less friction|', subline: 's', visual: 'A parcel slipping through a narrow door.', visualLink: 'A heavy parcel stands for big files.', caption: 'c', hashtags: ['#a'] };

test('the model is asked for a picture a viewer can link to the headline, and to say how', () => {
  const prompt = userPrompt(brand, 4, []);
  assert.match(prompt, /"visualLink"/);
  assert.match(prompt, /belongs to the (topic|subject)/i);
  assert.match(prompt, /two seconds|2 seconds/i);
  assert.match(prompt, /No people/i);
});

test('a draft needs a picture idea and a stated link to its headline, and a too-long headline is turned back', () => {
  assert.doesNotThrow(() => validateDraft(goodDraft, 1));
  assert.throws(() => validateDraft({ ...goodDraft, visual: '  ' }, 2), /post 2 needs a "visual"/);
  assert.throws(() => validateDraft({ ...goodDraft, visualLink: '' }, 3), /post 3 needs a "visualLink"/);
  assert.throws(() => validateDraft({ ...goodDraft, visualLink: undefined as unknown as string }, 1), /visualLink/);
  assert.throws(() => validateDraft({ ...goodDraft, headline: 'x'.repeat(61) }, 1), /headline is too long/);
});

test('an illustration is composed for the wide band the poster shows, not for the whole square', () => {
  const prompt = creativePrompt('illustration', 'x', brand);
  assert.match(prompt, /centered/i);
  assert.match(prompt, /top and bottom/i);
  assert.doesNotMatch(prompt, /empty space along the bottom/i);
});

test('the model is told to write for someone who has never heard of the brand: a plain-words headline, a subline that names the brand and what it does', () => {
  const prompt = userPrompt(brand, 4, []);
  assert.match(prompt, /never heard of/i);
  assert.match(prompt, /plain words/i);
  assert.match(prompt, /no jargon/i);
  assert.match(prompt, /subline[^\n]*names? (the brand|\$?\{?Acme)/i);
});

test('a subline that does not name the brand is turned back, so a stranger always learns whose post it is', () => {
  const named = { ...goodDraft, subline: 'Acme Dental books your next visit in one tap.' };
  assert.doesNotThrow(() => validateDraft(named, 1, 'Acme Dental'));
  assert.doesNotThrow(() => validateDraft({ ...goodDraft, subline: 'acme books visits fast.' }, 1, 'Acme Dental'));
  assert.throws(() => validateDraft(goodDraft, 2, 'Acme Dental'), /post 2 subline must name the brand \(Acme\)/);
  assert.throws(() => validateDraft({ ...goodDraft, subline: 'x'.repeat(95) + ' Acme' }, 1, 'Acme Dental'), /subline is too long/);
  assert.doesNotThrow(() => validateDraft(goodDraft, 3));
});

test('validateDraft turns back copy whose figures no verified claim supports, once the proof points are given', () => {
  const proof = ['Plans start from $29 per month.'];
  assert.doesNotThrow(() => validateDraft({ ...goodDraft, subline: 'Acme plans start from $29 per month.' }, 1, 'Acme Dental', proof));
  assert.throws(() => validateDraft({ ...goodDraft, subline: 'Acme saves you 12 hours.' }, 2, 'Acme Dental', proof), /post 2 has copy the claim gate turned back/);
  assert.throws(() => validateDraft({ ...goodDraft, subline: 'Acme keeps it simple.', caption: 'The best clinic software.' }, 3, 'Acme Dental', proof), /caption/);
});

test('the prompt tells the model which figures it may use', () => {
  const prompt = userPrompt({ ...brand, proofPoints: ['Plans start from $29 per month.'] }, 2, []);
  assert.match(prompt, /superlative[^.]*guarantee or deadline[^.]*only if a proof point/i);
});

const branded = {
  ...brand,
  handleUrl: 'acme.com',
  identity: { line: 'Family dental care for the whole town', kind: 'homepage', source: null, verification: { status: 'verified', reasons: [] } },
  cta: { kind: 'site-action', label: 'Book an appointment', evidence: null, text: 'Book an appointment at acme.com (link in bio)' },
} as unknown as Brand;
const shown = (b: Brand, format: PlannedPost['format']): string => renderCreativePostHtml({ brand: b, post: post(format), painPointNumber: 1, logoHtml: '<svg></svg>', visualUrl: 'file:///x.jpg' });

test('every poster format shows what the brand is and one plain call to action with the real address', () => {
  for (const format of FORMATS) {
    const html = shown(branded, format);
    assert.match(html, /class="identity">Family dental care for the whole town</, format);
    assert.match(html, /class="cta">Book an appointment <span>acme\.com<\/span></, format);
  }
});

test('a brand known only by its name shows no identity line, and an older profile shows neither', () => {
  const nameOnly = { ...branded, identity: { line: 'Acme Dental', kind: 'name-only', source: null, verification: { status: 'unverified', reasons: [] } } } as unknown as Brand;
  assert.doesNotMatch(shown(nameOnly, 'type'), /class="identity"/);
  assert.match(shown(nameOnly, 'type'), /class="cta"/);
  const old = shown(brand, 'type');
  assert.doesNotMatch(old, /class="identity"/);
  assert.doesNotMatch(old, /class="cta"/);
});

test('identity and call to action are escaped, and the fallback reads "Visit" with the address', () => {
  const risky = { ...branded, identity: { ...(branded.identity as object), line: 'Tools for <b>R&D</b>' }, cta: { kind: 'visit-site', label: 'Visit the website', evidence: null, text: 'Visit acme.com (link in bio)' } } as unknown as Brand;
  const html = shown(risky, 'illustration');
  assert.match(html, /Tools for &lt;b&gt;R&amp;D&lt;\/b&gt;/);
  assert.match(html, /class="cta">Visit the website <span>acme\.com<\/span></);
});

test('the call-to-action label is plain text, not a pill that looks like a button an image cannot offer', () => {
  const html = shown(branded, 'type');
  assert.doesNotMatch(html, /\.cta \{[^}]*(border:|border-radius: 999px)/);
});
