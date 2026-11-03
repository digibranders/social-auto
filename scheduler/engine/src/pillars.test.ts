import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchoredTo, assignWeek, availablePillars, defaultPillars, pillarsForWeek } from './pillars.ts';

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
  assert.deepEqual(availablePillars(bare).sort(), ['education', 'problem', 'story']);
  assert.ok(availablePillars({ ...bare, proofPoints: ['Open Saturdays'] }).includes('proof'));
  assert.ok(availablePillars({ ...bare, offer: 'Dental care for families' }).includes('offer'));
  assert.ok(!availablePillars({ ...bare, offer: '   ' }).includes('offer'));
});

test('assignments carry the brief, and each proof post gets its own verified proof point, rotating through them', () => {
  const brand = { proofPoints: ['Open Saturdays', 'Free first visit', 'Family discounts'], offer: 'Dental care' };
  const first = assignWeek({ brand, count: 5, recent: [], recentProofCount: 0 });
  assert.equal(first.length, 5);
  assert.ok(first.every((a) => a.brief.length > 20));
  const proofPosts = first.filter((a) => a.pillar === 'proof');
  assert.equal(proofPosts.length, 1);
  assert.equal(proofPosts[0]?.anchor, 'Open Saturdays');
  assert.ok(first.filter((a) => a.pillar !== 'proof').every((a) => a.anchor === undefined));
  const later = assignWeek({ brand, count: 5, recent: first.map((a) => a.pillar), recentProofCount: 1 });
  assert.equal(later.find((a) => a.pillar === 'proof')?.anchor, 'Free first visit');
});

test('a brand with no proof points never gets a proof post', () => {
  const week = assignWeek({ brand: { proofPoints: [], offer: 'Dental care' }, count: 8, recent: [], recentProofCount: 0 });
  assert.ok(week.every((a) => a.pillar !== 'proof'));
});

test('the pillars are settings: another set can be supplied', () => {
  const week = assignWeek({ brand: { proofPoints: [], offer: '' }, count: 2, recent: [], recentProofCount: 0, pillars: [{ name: 'tip', brief: 'Give one practical tip the audience can use today.', needs: null }, { name: 'news', brief: 'Share one update from the business in plain words.', needs: null }] });
  assert.deepEqual(week.map((a) => a.pillar).sort(), ['news', 'tip']);
});

test('a proof post must be built on its proof point: its main words appear in the copy', () => {
  const point = 'Free first visit for new patients';
  assert.equal(anchoredTo({ headline: 'Nervous about the dentist?', subline: 'Acme offers a free first visit.', caption: 'New patients start with a free first visit.' }, point), true);
  assert.equal(anchoredTo({ headline: 'Nervous about the dentist?', subline: 'Acme keeps it calm.', caption: 'We take our time with every person.' }, point), false);
});
