import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NO_DASH_RULE, withoutDashes } from './no-dashes.ts';

test('a dash between words becomes a comma, spaced or not', () => {
  assert.equal(withoutDashes('Fast — and simple'), 'Fast, and simple');
  assert.equal(withoutDashes('Fast—and simple'), 'Fast, and simple');
  assert.equal(withoutDashes('Fast – and simple'), 'Fast, and simple');
  assert.equal(withoutDashes('One ― two'), 'One, two');
});

test('a dash between numbers becomes a hyphen', () => {
  assert.equal(withoutDashes('Open 10–20 March'), 'Open 10-20 March');
  assert.equal(withoutDashes('2020—2024'), '2020-2024');
  assert.equal(withoutDashes('Mon–Fri'), 'Mon, Fri', 'letters are words, not numbers');
});

test('a dash at the end of a sentence or line becomes a full stop, at the start it goes', () => {
  assert.equal(withoutDashes('Book today —'), 'Book today.');
  assert.equal(withoutDashes('Book today. —'), 'Book today.');
  assert.equal(withoutDashes('— Book today'), 'Book today');
  assert.equal(withoutDashes('Line one —\nLine two'), 'Line one.\nLine two');
});

test('a dash after other punctuation does not double it, and the text without dashes is returned as it is', () => {
  assert.equal(withoutDashes('Wait, — what'), 'Wait, what');
  assert.equal(withoutDashes('Really? — yes'), 'Really? yes');
  assert.equal(withoutDashes('A well-known name, 10-20 days'), 'A well-known name, 10-20 days');
  assert.equal(withoutDashes(''), '');
});

test('no dash survives, whatever the input, and the rule text carries none itself outside the examples it names', () => {
  const messy = 'a — b – c—d –e— f — — g — 1–2 — end —';
  assert.doesNotMatch(withoutDashes(messy), /[—–―]/);
  assert.match(NO_DASH_RULE, /Never use an em dash/);
});

test('a written topic is stored and shown without a dash, whichever way it reaches the batch: written, a later week, a replacement, an added network', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { CopyStage } = await import('./copy-stage.ts');
  const dir = mkdtempSync(join(tmpdir(), 'nodash-'));
  try {
    const stage = new CopyStage(dir, 'acme', () => new Date('2026-11-16T10:00:00Z'));
    const dirty = (id: string, date: string): { postId: string; date: string; headline: string; caption: string; captions: Record<string, { text: string }> } =>
      ({ postId: id, date, headline: 'Fresh — every day', caption: 'Open 10–20 March — come in', captions: { linkedin: { text: 'Quality – always' } } });
    stage.open('week-01.json', [dirty('w01-d1', '2026-11-16')], undefined, { weeksDone: 1, weeksTotal: 2 });
    stage.appendWeek('week-01.json', [dirty('w01-d2', '2026-11-23')], [], { weeksDone: 2, weeksTotal: 2 }, () => undefined);
    stage.decide('week-01.json', 'w01-d1', 'dropped', 'owner');
    stage.addReplacement('week-01.json', 'w01-d1', dirty('w01-r1', '2026-11-16'), '2026-11-14');
    stage.addNetwork('week-01.json', 'facebook', { 'w01-d2': { facebook: { text: 'Soft — and warm' } } }, () => undefined);
    const batch = stage.get('week-01.json');
    const texts = batch.posts.flatMap((p) => [p.headline, p.caption, ...Object.values(p.captions ?? {}).map((c) => c.text)]);
    assert.ok(texts.length >= 8);
    for (const t of texts) assert.doesNotMatch(t, /[—–]/, t);
    assert.equal(batch.posts[0]?.headline, 'Fresh, every day');
    assert.equal(batch.posts[0]?.caption, 'Open 10-20 March, come in');
    assert.equal(batch.posts[1]?.captions?.['facebook']?.text, 'Soft, and warm');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
