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
    // It can be put away (shown as rejected), and still never approved.
    store.reject(v.versionId, 'owner', 'other');
    assert.equal(store.get(v.versionId).status, 'rejected');
    assert.equal(code(() => store.approve(v.versionId, 'owner')), 'ALREADY_DECIDED');
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
test('how a poster was branded is kept with its version, does not change the version\'s identity, and approval does not depend on it', () => {
  const s = setup();
  try {
    const branding = { intendedMode: 'authentic_logo' as const, appliedMode: 'text_only' as const, status: 'awaiting_compositor' as const, logoKind: 'wordmark' as const, logoAssetSha256: 'a'.repeat(64), reasonCode: 'LOGO_COMPOSITOR_UNAVAILABLE' as const };
    const plain = s.store.addVersion(input(s.picture('a.jpg', 'picture one')));
    assert.equal(plain.branding, undefined, 'a version with no record has none');
    const other = new ReviewStore(join(s.dir, 'other'), 'acme').addVersion(input(s.picture('b.jpg', 'picture one'), { branding }));
    assert.equal(other.versionId, plain.versionId, 'the record is not part of the version\'s identity');
    assert.equal(other.contentSha256, plain.contentSha256);
    assert.deepEqual(other.branding, branding);
    const stored = s.store.get(s.store.addVersion(input(s.picture('c.jpg', 'picture two'), { branding })).versionId);
    assert.deepEqual(stored.version.branding, branding, 'it survives a save and a load');
    s.store.approve(stored.version.versionId, 'owner');
    assert.equal(s.store.get(stored.version.versionId).status, 'approved');
  } finally {
    s.done();
  }
});


test('one post made for two networks is two lines of versions: a newer version for one network leaves the other network\'s approval alone', () => {
  const { store, pictures, done } = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'review-net-'));
    const store = new ReviewStore(dir, 'acme');
    return { store, pictures: (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p; }, done: () => rmSync(dir, { recursive: true, force: true }) };
  })();
  try {
    const base = { postId: 'w01-d1', planFile: 'week-01.json', headline: 'Answers from your own docs', caption: 'Same words.', ctaUrl: 'https://acme.example', factIds: ['f1'], evidence: [], validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.017 };
    const ig = store.addVersion({ ...base, network: 'instagram', imagePath: pictures('ig.jpg', 'square picture') });
    const li = store.addVersion({ ...base, network: 'linkedin', width: 1536, height: 1024, imagePath: pictures('li.jpg', 'wide picture') });
    assert.notEqual(ig.versionId, li.versionId, 'the same words on two networks are two versions');
    assert.equal(li.width, 1536);
    store.approve(ig.versionId, 'owner');
    store.approve(li.versionId, 'owner');
    // A changed Instagram caption is a new Instagram version; LinkedIn stays approved.
    const ig2 = store.addVersion({ ...base, caption: 'Different words.', network: 'instagram', imagePath: pictures('ig.jpg', 'square picture') });
    assert.equal(ig2.versionNumber, 2);
    assert.equal(store.get(ig.versionId).status, 'superseded');
    assert.equal(store.get(ig2.versionId).status, 'pending');
    assert.equal(store.get(li.versionId).status, 'approved', 'the other network is untouched');
    assert.deepEqual(store.history('w01-d1', 'linkedin').map((i) => i.version.versionId), [li.versionId]);
    assert.equal(store.history('w01-d1').length, 3);
    // A poster made for a network is not released through the post's name alone.
    assert.equal(store.approvedFor('w01-d1'), undefined);
    assert.deepEqual(store.approvedForNetworks('w01-d1').map((a) => a.version.network), ['linkedin']);
  } finally {
    done();
  }
});

test('a version made without a network behaves exactly as before, and a bad network name is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-legacy-'));
  try {
    const store = new ReviewStore(dir, 'acme');
    writeFileSync(join(dir, 'a.jpg'), 'picture');
    const input = { postId: 'p1', planFile: 'week-01.json', headline: 'H', caption: 'C', ctaUrl: 'https://acme.example', factIds: [], evidence: [], imagePath: join(dir, 'a.jpg'), validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.01 };
    const v = store.addVersion(input);
    assert.equal(v.network, undefined);
    assert.equal(store.addVersion(input).versionId, v.versionId, 'the same thing registered twice is one version');
    store.approve(v.versionId, 'owner');
    assert.equal(store.approvedFor('p1')?.version.versionId, v.versionId);
    assert.throws(() => store.addVersion({ ...input, network: 'Insta gram!' }), /short lower-case/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Carousels

const slide = (picture: (n: string, t: string) => string, n: number, over: Partial<NewVersion> = {}): NewVersion =>
  input(picture(`s${n}.jpg`, `slide ${n}`), { postId: `car1-s${n}`, headline: `Slide ${n}`, caption: '', factIds: ['f1'], carousel: { id: 'car1', position: n, count: 3 }, ...over });
const captionFor = (picture: (n: string, t: string) => string, network: string): NewVersion =>
  input(picture('cover.jpg', 'slide 1'), { postId: 'car1', network, headline: 'Choosing a curry', caption: `A caption for ${network}`, carousel: { id: 'car1', position: 0, count: 3 } });

function carousel(store: ReviewStore, picture: (n: string, t: string) => string, networks: string[] = ['instagram', 'linkedin']): void {
  for (const n of [1, 2, 3]) store.addVersion(slide(picture, n));
  for (const network of networks) store.addVersion(captionFor(picture, network));
}

test('a carousel is stored as slides and captions that know their group', () => {
  const { store, picture, done } = setup();
  try {
    carousel(store, picture);
    const found = store.carouselSlides('car1');
    assert.equal(found.count, 3);
    assert.deepEqual(found.slides.map((s) => s?.version.postId), ['car1-s1', 'car1-s2', 'car1-s3']);
    assert.deepEqual(found.captions.map((c) => c.version.network).sort(), ['instagram', 'linkedin']);
    assert.equal(store.isCarousel('car1'), true);
    assert.equal(store.isCarousel('w01-d1'), false);
    assert.equal(store.list().length, 5);
  } finally {
    done();
  }
});

test('one approval covers every slide and every caption, and then the carousel can be posted', () => {
  const { store, picture, done } = setup();
  try {
    carousel(store, picture);
    assert.equal(code(() => store.approvedCarousel('car1')), 'NOT_APPROVED');
    store.approveCarousel('car1', 'owner');
    assert.ok(store.list().every((i) => i.status === 'approved'));
    const ready = store.approvedCarousel('car1');
    assert.deepEqual(ready.slides.map((s) => s.version.headline), ['Slide 1', 'Slide 2', 'Slide 3']);
    assert.deepEqual(ready.captions.map((c) => c.version.network).sort(), ['instagram', 'linkedin']);
    assert.equal(ready.slides[0]?.bytes.toString(), 'slide 1');
    store.approveCarousel('car1', 'owner');
    assert.equal(store.list().length, 5, 'approving again changes nothing');
  } finally {
    done();
  }
});

test('nothing is approved unless the whole carousel can be: a missing slide, a blocked slide or no caption stops it', () => {
  const { store, picture, done } = setup();
  try {
    store.addVersion(slide(picture, 1));
    store.addVersion(slide(picture, 3));
    store.addVersion(captionFor(picture, 'instagram'));
    assert.equal(code(() => store.approveCarousel('car1', 'owner')), 'INVALID', 'slide 2 is missing');
    store.addVersion(slide(picture, 2, { validation: { accepted: false, readings: 2, defects: ['extra text'], reportFile: 'r.json' } }));
    assert.equal(code(() => store.approveCarousel('car1', 'owner')), 'BLOCKED');
    assert.ok(store.list().every((i) => i.status !== 'approved'), 'no slide was approved on the way');

    const second = setup();
    try {
      for (const n of [1, 2, 3]) second.store.addVersion(slide(second.picture, n));
      assert.equal(code(() => second.store.approveCarousel('car1', 'owner')), 'INVALID', 'no caption was written');
      assert.ok(second.store.list().every((i) => i.status === 'pending'));
    } finally {
      second.done();
    }
  } finally {
    done();
  }
});

test('a slide redrawn after approval makes the carousel wait for a new approval, and the old slide is not posted', () => {
  const { store, picture, done } = setup();
  try {
    carousel(store, picture);
    store.approveCarousel('car1', 'owner');
    const redrawn = store.addVersion(slide(picture, 2, { headline: 'Slide 2 again' }));
    assert.equal(code(() => store.approvedCarousel('car1')), 'NOT_APPROVED');
    assert.equal(store.get(redrawn.versionId).status, 'pending');
    store.approveCarousel('car1', 'owner');
    assert.equal(store.approvedCarousel('car1').slides[1]?.version.headline, 'Slide 2 again');
  } finally {
    done();
  }
});

test('rejecting a carousel withdraws every slide and caption, and a rejected slide blocks approval', () => {
  const { store, picture, done } = setup();
  try {
    carousel(store, picture);
    store.rejectCarousel('car1', 'owner', 'style', 'not our look');
    assert.ok(store.list().every((i) => i.status === 'rejected'));
    assert.equal(code(() => store.approveCarousel('car1', 'owner')), 'ALREADY_DECIDED');
    const other = setup();
    try {
      carousel(other.store, other.picture);
      other.store.reject(other.store.carouselSlides('car1').slides[1]?.version.versionId ?? '', 'owner', 'poor_design');
      assert.equal(code(() => other.store.approveCarousel('car1', 'owner')), 'ALREADY_DECIDED');
    } finally {
      other.done();
    }
  } finally {
    done();
  }
});

test('a slide picture that changed after approval stops the carousel from being posted', () => {
  const { dir, store, picture, done } = setup();
  try {
    carousel(store, picture);
    store.approveCarousel('car1', 'owner');
    const file = store.carouselSlides('car1').slides[0]?.version.imageFile ?? '';
    writeFileSync(join(dir, 'brand', file), 'swapped');
    assert.equal(code(() => store.approvedCarousel('car1')), 'TAMPERED');
  } finally {
    done();
  }
});
