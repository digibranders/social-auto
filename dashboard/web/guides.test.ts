import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUIDES } from './guides.ts';
import { GUIDE_KEYS } from './route.ts';

test('every channel has a complete guide: one-time setup, per-client steps, a check, and later', () => {
  for (const key of GUIDE_KEYS) {
    const guide = GUIDES[key];
    assert.ok(guide.name && guide.intro && guide.needs.length >= 3, key);
    const titles = guide.groups.map((g) => g.title);
    assert.ok(titles.some((t) => /One-time/.test(t)), `${key} one-time`);
    assert.ok(titles.some((t) => /each new client/.test(t)), `${key} per client`);
    assert.ok(titles.some((t) => /Check/.test(t)), `${key} check`);
    assert.ok(titles.some((t) => /Later/.test(t)), `${key} later`);
    assert.ok(guide.problems.length >= 3, `${key} problems`);
  }
});

test('every step says who does it, explains itself, and has a picture with a highlighted row', () => {
  for (const key of GUIDE_KEYS) {
    for (const group of GUIDES[key].groups) {
      assert.ok(group.steps.length > 0, `${key} ${group.title}`);
      for (const step of group.steps) {
        assert.ok(['client', 'you', 'system'].includes(step.who), step.t);
        assert.ok(step.t.length > 3 && step.d.length > 15, step.t);
        assert.ok(step.shot.url && step.shot.rows.length > 0, step.t);
        assert.ok(step.shot.rows.some((r) => r.hi) || step.shot.btn, `${key}: "${step.t}" highlights nothing`);
      }
    }
  }
});

test('guides are generic: no real client, account or person appears in them', () => {
  const text = JSON.stringify(GUIDES);
  for (const name of ['Brandbs', 'Brandbasket', 'dai23_sy', 'Steve', 'Steff', 'Currycook', 'brandbasket.in']) {
    assert.ok(!text.includes(name), `guides mention ${name}`);
  }
  assert.ok(!/EAA[A-Za-z0-9]{20,}|access_token=|[0-9a-f]{32,}/.test(text), 'something looks like a secret');
});

test('the Facebook guide has the lessons we learned the hard way', () => {
  const text = JSON.stringify(GUIDES.facebook);
  for (const lesson of ['Public page', 'full control', 'profile link or numeric ID', 'current Pages only', 'popup too small']) {
    assert.ok(text.includes(lesson) || text.toLowerCase().includes(lesson.toLowerCase()), lesson);
  }
});
