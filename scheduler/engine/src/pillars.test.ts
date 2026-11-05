import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchoredTo, assignWeek, availablePillars, checkAnchored, defaultPillars, pillarsForWeek } from './pillars.ts';

const NAMES = defaultPillars.map((p) => p.name);

test('a week with no more posts than pillars never repeats a pillar', () => {
  for (let count = 1; count <= NAMES.length; count++) {
    const week = pillarsForWeek({ count, available: NAMES, recent: [] });
    assert.equal(new Set(week).size, count, `${count} posts: ${week.join(',')}`);
  }
});

test('a longer week is balanced: no pillar more than one post ahead of another, never twice in a row', () => {
  const week = pillarsForWeek({ count: 12, available: NAMES, recent: [] });
  const counts = NAMES.map((n) => week.filter((w) => w === n).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, counts.join(','));
  for (let i = 1; i < week.length; i++) assert.notEqual(week[i], week[i - 1]);
});

test('the next week continues the rotation: it does not open with the pillar that closed the last, and favours what was used least', () => {
  const first = pillarsForWeek({ count: 3, available: NAMES, recent: [] });
  const second = pillarsForWeek({ count: 3, available: NAMES, recent: first });
  assert.notEqual(second[0], first[2]);
  assert.deepEqual(second.slice(0, 2).sort(), ['offer', 'story']);
  assert.equal(second[2], first[0], `${first} then ${second}`);
});

test('over many weeks every pillar is used about equally', () => {
  let recent: string[] = [];
  for (let w = 0; w < 10; w++) recent = [...recent, ...pillarsForWeek({ count: 3, available: NAMES, recent })];
  const counts = NAMES.map((n) => recent.filter((r) => r === n).length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, counts.join(','));
});

test('it is deterministic, and one available pillar fills the whole week', () => {
  assert.deepEqual(pillarsForWeek({ count: 5, available: NAMES, recent: ['proof'] }), pillarsForWeek({ count: 5, available: NAMES, recent: ['proof'] }));
  assert.deepEqual(pillarsForWeek({ count: 3, available: ['problem'], recent: [] }), ['problem', 'problem', 'problem']);
  assert.throws(() => pillarsForWeek({ count: 2, available: [], recent: [] }), /no pillar/i);
});

test('a pillar is offered only when the evidence for it exists', () => {
  const bare = { proofPoints: [] as string[], offer: '' };
  assert.deepEqual(availablePillars(bare), []);
  assert.deepEqual(availablePillars({ ...bare, offer: 'Dental care for families' }).sort(), ['offer', 'problem']);
  assert.deepEqual(availablePillars({ ...bare, proofPoints: ['Open Saturdays'] }).sort(), ['education', 'proof']);
  assert.deepEqual(availablePillars({ ...bare, identity: { kind: 'homepage' } }), ['story']);
  assert.deepEqual(availablePillars({ ...bare, identity: { kind: 'name-only' } }), []);
  assert.deepEqual(availablePillars({ ...bare, offer: '   ' }), []);
});

test('education and proof are both built on a verified proof point, taking them in turn', () => {
  const brand = { proofPoints: ['Open Saturdays', 'Free first visit', 'Family discounts'], offer: 'Dental care', identity: { kind: 'homepage' } };
  const week = assignWeek({ brand, count: 5, recent: [], recentAnchoredCount: 0 });
  assert.equal(week.length, 5);
  assert.ok(week.every((a) => a.brief.length > 20));
  assert.deepEqual(week.map((a) => a.pillar).sort(), ['education', 'offer', 'problem', 'proof', 'story']);
  const anchored = week.filter((a) => a.anchor !== undefined);
  assert.deepEqual(anchored.map((a) => a.pillar).sort(), ['education', 'proof']);
  assert.deepEqual(anchored.map((a) => a.anchor), ['Open Saturdays', 'Free first visit']);
  assert.ok(week.filter((a) => a.anchor === undefined).every((a) => !['proof', 'education'].includes(a.pillar)));
  const later = assignWeek({ brand, count: 5, recent: week.map((a) => a.pillar), recentAnchoredCount: 2 });
  assert.deepEqual(later.filter((a) => a.anchor !== undefined).map((a) => a.anchor), ['Family discounts', 'Open Saturdays']);
});

test('without evidence there is no education or proof post, and with nothing at all the week says so', () => {
  const week = assignWeek({ brand: { proofPoints: [], offer: 'Dental care' }, count: 8, recent: [], recentAnchoredCount: 0 });
  assert.ok(week.every((a) => a.pillar === 'problem' || a.pillar === 'offer'));
  assert.throws(() => assignWeek({ brand: { proofPoints: [], offer: '' }, count: 2, recent: [], recentAnchoredCount: 0 }), /no pillar/i);
});

test('weights are settings: a heavier pillar comes up more often, and weight zero switches a pillar off', () => {
  const specs = defaultPillars.map((p) => (p.name === 'proof' ? { ...p, weight: 2 } : p.name === 'story' ? { ...p, weight: 0 } : p));
  const brand = { proofPoints: ['Open Saturdays'], offer: 'Dental care', identity: { kind: 'homepage' } };
  const week = assignWeek({ brand, count: 12, recent: [], recentAnchoredCount: 0, pillars: specs }).map((a) => a.pillar);
  const count = (n: string) => week.filter((w) => w === n).length;
  assert.equal(count('story'), 0);
  assert.ok(count('proof') >= count('offer') * 1.5, week.join(','));
  for (let i = 1; i < week.length; i++) assert.notEqual(week[i], week[i - 1]);
});

test('the pillars are settings: another set can be supplied', () => {
  const week = assignWeek({ brand: { proofPoints: [], offer: '' }, count: 2, recent: [], recentAnchoredCount: 0, pillars: [{ name: 'tip', brief: 'Give one practical tip the audience can use today.', needs: null }, { name: 'news', brief: 'Share one update from the business in plain words.', needs: null }] });
  assert.deepEqual(week.map((a) => a.pillar).sort(), ['news', 'tip']);
});

test('a proof post must be built on its proof point: its main words appear in the copy', () => {
  const point = 'Free first visit for new patients';
  assert.equal(anchoredTo({ headline: 'Nervous about the dentist?', subline: 'Acme offers a free first visit.', caption: 'New patients start with a free first visit.' }, point), true);
  assert.equal(anchoredTo({ headline: 'Nervous about the dentist?', subline: 'Acme keeps it calm.', caption: 'We take our time with every person.' }, point), false);
});

test('word overlap is not enough: a sentence that reverses or changes the proof point is turned back', () => {
  const point = 'Our platform does not guarantee next-day delivery';
  const copy = (sentence: string) => ({ headline: 'Delivery, explained', subline: 'Acme is plain about delivery.', caption: sentence });
  assert.match(checkAnchored(copy('Our platform guarantees next-day delivery.'), point) ?? '', /changes the proof point|negat/i);
  assert.equal(checkAnchored(copy('Our platform does not guarantee next-day delivery.'), point), undefined);
  const priced = 'Plans start from $29 per month';
  assert.match(checkAnchored(copy('Plans start from $25 per month.'), priced) ?? '', /\$25/);
  assert.match(checkAnchored(copy('Plans start from $29 per year.'), priced) ?? '', /year/);
});

test('a faithful paraphrase that keeps the figures is not turned back for using different words', () => {
  const point = 'Setup takes about 10 minutes';
  const copy = { headline: 'Be up and running quickly', subline: 'Acme Dental is ready within about 10 minutes of setup.', caption: 'Getting started is quick.' };
  assert.equal(checkAnchored(copy, point), undefined);
});

test('a paraphrase with no figures and little shared wording cannot be confirmed, so it is turned back', () => {
  const point = 'Free first visit for new patients';
  assert.ok(checkAnchored({ headline: 'Come and meet us', subline: 'Acme Dental welcomes newcomers at no cost.', caption: 'Your opening appointment costs nothing.' }, point));
});

test('anchoring does not depend on English word shapes for figures: numbers and units are compared as they are', () => {
  const point = '25 integraciones disponibles';
  assert.equal(checkAnchored({ headline: 'Conecta todo', subline: 'Acme Dental ofrece 25 integraciones.', caption: 'Más de lo que imaginas.' }, point), undefined);
  assert.ok(checkAnchored({ headline: 'Conecta todo', subline: 'Acme Dental ofrece 30 integraciones.', caption: 'Más de lo que imaginas.' }, point));
});
