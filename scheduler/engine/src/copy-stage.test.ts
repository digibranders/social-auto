import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStage, CopyStageError } from './copy-stage.ts';

const posts = [
  { postId: 'p1', headline: 'Plan every task in one place', caption: 'Keep your team on the same page.' },
  { postId: 'p2', headline: 'See who is free this week', caption: 'Workload view shows capacity.' },
];

function stage(): { stage: CopyStage; dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'copy-'));
  return { stage: new CopyStage(dir, 'acme', () => new Date('2026-11-06T10:00:00Z')), dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const code = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof CopyStageError, String(error));
    return error.code;
  }
  return assert.fail('no error');
};

test('a new batch starts with every post pending, and opening it again keeps earlier choices', () => {
  const { stage: s, done } = stage();
  try {
    s.open('week-01.json', posts);
    s.decide('week-01.json', 'p1', 'kept', 'owner');
    const again = s.open('week-01.json', posts);
    assert.deepEqual(again.posts.map((p) => p.state), ['kept', 'pending']);
  } finally {
    done();
  }
});

test('only kept posts are drawn, and a post whose words changed after it was kept is left out', () => {
  const { stage: s, done } = stage();
  try {
    s.open('week-01.json', posts);
    s.decide('week-01.json', 'p1', 'kept', 'owner');
    s.decide('week-01.json', 'p2', 'kept', 'owner');
    s.decide('week-01.json', 'p2', 'dropped', 'owner');
    assert.deepEqual(s.toDraw('week-01.json', posts), { postIds: ['p1'], changed: [] });
    const edited = [{ ...posts[0]!, caption: 'A different caption.' }, posts[1]!];
    assert.deepEqual(s.toDraw('week-01.json', edited), { postIds: [], changed: ['p1'] });
  } finally {
    done();
  }
});

test('a pending post is never drawn', () => {
  const { stage: s, done } = stage();
  try {
    s.open('week-01.json', posts);
    assert.deepEqual(s.toDraw('week-01.json', posts).postIds, []);
  } finally {
    done();
  }
});

test('after the batch is sent to be drawn the choices are final and it cannot be drawn twice', () => {
  const { stage: s, done } = stage();
  try {
    s.open('week-01.json', posts);
    s.decide('week-01.json', 'p1', 'kept', 'owner');
    s.markDrawn('week-01.json');
    assert.equal(code(() => s.decide('week-01.json', 'p2', 'kept', 'owner')), 'ALREADY_DRAWN');
    assert.equal(code(() => s.markDrawn('week-01.json')), 'ALREADY_DRAWN');
  } finally {
    done();
  }
});

test('names that are not a plan file, a post or a person are refused, and unknown ones are not found', () => {
  const { stage: s, done } = stage();
  try {
    assert.equal(code(() => s.open('../week-01.json', posts)), 'INVALID');
    s.open('week-01.json', posts);
    assert.equal(code(() => s.decide('week-01.json', '../x', 'kept', 'owner')), 'INVALID');
    assert.equal(code(() => s.decide('week-01.json', 'p1', 'kept', ' ')), 'INVALID');
    assert.equal(code(() => s.decide('week-01.json', 'zzz', 'kept', 'owner')), 'NOT_FOUND');
    assert.equal(code(() => s.get('week-09.json')), 'NOT_FOUND');
  } finally {
    done();
  }
});

test('the list shows every batch of the brand in order', () => {
  const { stage: s, dir, done } = stage();
  try {
    s.open('week-02.json', posts);
    s.open('week-01.json', posts);
    writeFileSync(join(dir, 'copy-first', 'notes.txt'), 'ignored');
    assert.deepEqual(s.list().map((b) => b.planFile), ['week-01.json', 'week-02.json']);
    assert.match(readFileSync(join(dir, 'copy-first', 'week-01.json'), 'utf8'), /"state": "pending"/);
  } finally {
    done();
  }
});

test('advice about a weak headline is kept with the post and does not decide anything', () => {
  const { stage: s, done } = stage();
  try {
    const batch = s.open('week-01.json', [{ ...posts[0]!, advice: 'weak headline: it tells the reader nothing specific' }, posts[1]!]);
    assert.equal(batch.posts[0]?.advice, 'weak headline: it tells the reader nothing specific');
    assert.equal(batch.posts[1]?.advice, undefined);
    assert.deepEqual(batch.posts.map((p) => p.state), ['pending', 'pending']);
  } finally {
    done();
  }
});
