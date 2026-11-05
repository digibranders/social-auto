import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewError, ReviewStore, type NewVersion } from './review-store.ts';

function setup(): { dir: string; store: ReviewStore; picture: (name: string, text: string) => string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  return {
    dir,
    store: new ReviewStore(join(dir, 'brand'), 'acme'),
    picture: (name, text) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const input = (imagePath: string, over: Partial<NewVersion> = {}): NewVersion => ({
  postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers from your own docs', caption: 'Hook.\n\nWhat the facts say.\n\nSee oyechats.com', ctaUrl: 'https://oyechats.com',
  factIds: ['f1'], evidence: [{ factId: 'f1', text: 'Answers from docs', quote: 'Answers from your own documents', url: 'https://oyechats.com/', context: 'Features' }],
  imagePath, validation: { accepted: true, readings: 2, defects: [], reportFile: 'creative-report.json' }, attempts: 1, costUsd: 0.016, ...over,
});

const code = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ReviewError, String(error));
    return error.code;
  }
  return 'NO_ERROR';
};

test('a new poster is pending; registering the same one again makes nothing new', () => {
  const { store, picture, done } = setup();
  try {
    const first = store.addVersion(input(picture('a.jpg', 'picture one')));
    const again = store.addVersion(input(picture('a2.jpg', 'picture one')));
    assert.equal(first.versionId, again.versionId);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(first.versionId).status, 'pending');
    assert.equal(first.versionNumber, 1);
    assert.match(first.imageFile, /^versions\/[0-9a-f]{64}\.jpg$/);
  } finally {
    done();
  }
});

test('approval belongs to the exact version: approving twice is one decision, and a download needs that approval', () => {
  const { store, picture, dir, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'picture one')));
    assert.equal(code(() => store.approvedFile(v.versionId)), 'NOT_APPROVED');
    const first = store.approve(v.versionId, 'owner');
    const second = new ReviewStore(join(dir, 'brand'), 'acme').approve(v.versionId, 'owner');
    assert.deepEqual(second, first);
    assert.equal(readFileSync(join(dir, 'brand', 'reviews.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"decision"')).length, 1, 'one record, not two');
    assert.equal(readFileSync(store.approvedFile(v.versionId).path, 'utf8'), 'picture one');
    assert.equal(store.get(v.versionId).status, 'approved');
  } finally {
    done();
  }
});

test('a version the system did not pass is blocked: it cannot be approved, and nothing is published from it', () => {
  const { store, picture, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'x'), { validation: { accepted: false, readings: 2, defects: ['extra_text'], reportFile: 'r.json' } }));
    assert.equal(store.get(v.versionId).status, 'blocked');
    assert.equal(code(() => store.approve(v.versionId, 'owner')), 'BLOCKED');
    assert.equal(code(() => store.approvedFile(v.versionId)), 'NOT_APPROVED');
  } finally {
    done();
  }
});

test('an edit makes a new pending version; the earlier approval stays on record but no longer goes out', () => {
  const { store, picture, done } = setup();
  try {
    const v1 = store.addVersion(input(picture('a.jpg', 'picture one')));
    store.approve(v1.versionId, 'owner');
    assert.ok(store.approvedFor('w01-d1'));
    const v2 = store.addVersion(input(picture('a.jpg', 'picture one'), { caption: 'A different caption.', parentVersionId: v1.versionId, createdBy: 'owner' }));
    assert.equal(v2.versionNumber, 2);
    assert.equal(store.get(v2.versionId).status, 'pending');
    assert.equal(store.get(v1.versionId).status, 'superseded');
    assert.equal(store.approvedFor('w01-d1'), undefined, 'the edited version is not approved, so nothing goes out');
    assert.equal(store.get(v1.versionId).decision?.decision, 'approve', 'the history is kept');
    assert.equal(code(() => store.approve(v1.versionId, 'owner')), 'STALE', 'a superseded version cannot be approved again');
    assert.equal(code(() => store.approvedFile(v1.versionId)), 'NOT_APPROVED');
    store.approve(v2.versionId, 'owner');
    assert.equal(store.approvedFor('w01-d1')?.version.versionId, v2.versionId);
    assert.deepEqual(store.history('w01-d1').map((i) => i.version.versionNumber), [2, 1]);
  } finally {
    done();
  }
});

test('an older pending version cannot be approved once a newer one exists', () => {
  const { store, picture, done } = setup();
  try {
    const v1 = store.addVersion(input(picture('a.jpg', 'one')));
    store.addVersion(input(picture('b.jpg', 'two')));
    assert.equal(code(() => store.approve(v1.versionId, 'owner')), 'STALE');
  } finally {
    done();
  }
});

test('a picture changed on disk after the version was made is never approved or published', () => {
  const { store, picture, dir, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'picture one')));
    writeFileSync(join(dir, 'brand', v.imageFile), 'swapped');
    assert.equal(code(() => store.approve(v.versionId, 'owner')), 'TAMPERED');
    assert.equal(code(() => store.previewPath(v.versionId)), 'TAMPERED');
  } finally {
    done();
  }
});

test('an approved picture that is swapped afterwards is refused at download and scheduling', () => {
  const { store, picture, dir, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'picture one')));
    store.approve(v.versionId, 'owner');
    writeFileSync(join(dir, 'brand', v.imageFile), 'swapped');
    assert.equal(code(() => store.approvedFile(v.versionId)), 'TAMPERED');
    assert.equal(code(() => store.approvedFor('w01-d1')), 'TAMPERED');
  } finally {
    done();
  }
});

test('a rejection needs a listed reason, is kept with its comment, cannot be approved afterwards, and repeating it changes nothing', () => {
  const { store, picture, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'x')));
    assert.equal(code(() => store.reject(v.versionId, 'owner', 'nonsense' as never)), 'INVALID');
    const rejected = store.reject(v.versionId, 'owner', 'irrelevant_image', 'shows a laptop');
    assert.equal(rejected.reason, 'irrelevant_image');
    assert.equal(store.get(v.versionId).status, 'rejected');
    assert.deepEqual(store.reject(v.versionId, 'owner', 'poor_design'), rejected);
    assert.equal(code(() => store.approve(v.versionId, 'owner')), 'ALREADY_DECIDED');
    assert.equal(code(() => store.approvedFile(v.versionId)), 'NOT_APPROVED');
  } finally {
    done();
  }
});

test('an approved poster can be withdrawn before it goes out, and then nothing is published', () => {
  const { store, picture, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'x')));
    store.approve(v.versionId, 'owner');
    store.reject(v.versionId, 'owner', 'factual_issue');
    assert.equal(store.get(v.versionId).status, 'rejected');
    assert.equal(store.approvedFor('w01-d1'), undefined);
  } finally {
    done();
  }
});

test('decisions need a person, and a missing version is not found', () => {
  const { store, picture, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'x')));
    assert.equal(code(() => store.approve(v.versionId, ' ')), 'INVALID');
    assert.equal(code(() => store.approve('acme.nope', 'owner')), 'NOT_FOUND');
  } finally {
    done();
  }
});

test('a damaged record stops every decision until a person looks', () => {
  const { store, picture, dir, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'x')));
    appendFileSync(join(dir, 'brand', 'reviews.jsonl'), 'not json\n');
    assert.equal(code(() => store.approve(v.versionId, 'owner')), 'TAMPERED');
    assert.equal(code(() => store.list()), 'TAMPERED');
  } finally {
    done();
  }
});

test('a version of one brand is never found in another brand\'s store', () => {
  const { dir, store, picture, done } = setup();
  try {
    const v = store.addVersion(input(picture('a.jpg', 'x')));
    const other = new ReviewStore(join(dir, 'other'), 'globex');
    assert.equal(code(() => other.get(v.versionId)), 'NOT_FOUND');
    assert.equal(other.list().length, 0);
  } finally {
    done();
  }
});

test('while another live process holds the store\'s lock nothing is decided, and the caller is told it is busy; once it lets go the decision is made once', async () => {
  const { spawn } = await import('node:child_process');
  const { dir, picture, done } = setup();
  try {
    const brandDir = join(dir, 'brand');
    const store = new ReviewStore(brandDir, 'acme', () => new Date(), 300);
    const v = store.addVersion(input(picture('a.jpg', 'x')));
    const holder = spawn(process.execPath, [new URL('./lock-worker.ts', import.meta.url).pathname, 'hold', join(brandDir, 'reviews.jsonl.lock'), '1500'], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => holder.stdout?.on('data', (d: Buffer) => d.toString().includes('HELD') && resolve()));
    assert.equal(code(() => store.approve(v.versionId, 'owner')), 'LOCKED');
    assert.equal(store.get(v.versionId).status, 'pending', 'nothing was decided while the lock was held elsewhere');
    await new Promise((resolve) => holder.on('close', resolve));
    assert.equal(store.approve(v.versionId, 'owner').decision, 'approve');
  } finally {
    done();
  }
});
