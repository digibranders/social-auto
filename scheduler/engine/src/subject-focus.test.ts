import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromePath } from './platform.ts';
import { findSubject, focusFor, subjectFits, type SubjectBox } from './subject-focus.ts';

const real = { skip: existsSync(chromePath(process.env, process.platform)) ? false : 'Chrome is not installed' };
const tall = (x0: number, x1: number, y0 = 0.3, y1 = 0.8): SubjectBox => ({ x0, x1, y0, y1, width: 1024, height: 1536 });

test('a panel narrower than the picture is positioned on the subject: far right, far left, and centred', () => {
  const panel = 0.48;
  assert.equal(focusFor(tall(0.5, 1), panel).x, 100);
  assert.equal(focusFor(tall(0, 0.4), panel).x, 0);
  const middle = focusFor(tall(0.4, 0.6), panel);
  assert.ok(middle.x > 30 && middle.x < 70, `centred, got ${middle.x}`);
  assert.equal(middle.y, 50, 'the axis that is not cropped does not move');
});

test('a wide panel over a square picture moves the picture up or down, and a panel of the same shape does not move it', () => {
  const square: SubjectBox = { x0: 0.2, x1: 0.8, y0: 0.6, y1: 1, width: 1000, height: 1000 };
  const wide = focusFor(square, 2);
  assert.equal(wide.x, 50);
  assert.equal(wide.y, 100);
  assert.deepEqual(focusFor(square, 1), { x: 50, y: 50 });
});

test('subjectFits says whether the subject with a small margin fits what the panel shows, with the margin stopping at the picture edge', () => {
  assert.equal(subjectFits(tall(0.3125, 1), 0.48), true);
  assert.equal(subjectFits(tall(0, 0.9), 0.48), false);
  assert.equal(subjectFits(tall(0.2, 0.4), 0.48), true);
});

test('real Chrome: the subject of a picture is found, and a picture with no clear subject is not guessed at', real, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'subject-'));
  try {
    const subject = join(dir, 'subject.svg');
    await writeFile(subject, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#f4503c"/><rect x="220" y="260" width="160" height="200" fill="#111111"/></svg>');
    const box = await findSubject(subject);
    assert.ok(box, 'a subject is found');
    assert.ok(box.x0 > 0.45 && box.x0 < 0.6, `left edge near 0.55, got ${box.x0}`);
    assert.ok(box.x1 > 0.9, `right edge near 0.95, got ${box.x1}`);
    assert.ok(box.y0 > 0.38 && box.y1 < 0.85);
    assert.equal(box.width, 400);

    const empty = join(dir, 'empty.svg');
    await writeFile(empty, '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#f4503c"/></svg>');
    assert.equal(await findSubject(empty), undefined);
    assert.equal(await findSubject(join(dir, 'missing.jpg')), undefined);
    assert.equal(await findSubject(join(dir, 'notes.txt')), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

import { subjectOnCanvas } from './subject-focus.ts';

test('the subject is placed on the poster from the panel, the cover scaling and the focus, and stays inside the panel', () => {
  const panel = { x: 560, y: 0, w: 520, h: 1080 };
  const box: SubjectBox = { x0: 0.3125, x1: 1, y0: 0.25, y1: 0.83, width: 1024, height: 1536 };
  const placed = subjectOnCanvas(box, panel, { x: 100, y: 50 });
  assert.ok(placed.x >= 560 && placed.x + placed.w <= 1080 + 1e-6, 'inside the panel');
  assert.ok(placed.w > 400 && placed.w <= 520, `wide, got ${placed.w}`);
  const centred = subjectOnCanvas({ x0: 0.25, x1: 0.75, y0: 0.25, y1: 0.75, width: 1000, height: 1000 }, { x: 0, y: 0, w: 1000, h: 1000 }, { x: 50, y: 50 });
  assert.deepEqual(centred, { x: 250, y: 250, w: 500, h: 500 });
  const cropped = subjectOnCanvas({ x0: 0.8, x1: 1, y0: 0, y1: 1, width: 1000, height: 1000 }, { x: 0, y: 0, w: 500, h: 1000 }, { x: 0, y: 50 });
  assert.equal(cropped.w, 0, 'a subject wholly outside the visible part of the picture has no area on the poster');
});
