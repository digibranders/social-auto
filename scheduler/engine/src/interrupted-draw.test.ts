import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTO_POST_BY, runAutoPosting, writeAutoPosting } from './auto-posting.ts';
import { writeConnected } from './connected-networks.ts';
import { CopyStage, postLocked } from './copy-stage.ts';
import { recordInterruptedDraw } from './interrupted-draw.ts';
import { ProductBrands } from './product-brands.ts';

const post = (id: string, date: string) => ({ postId: id, date, headline: `H ${id}`, caption: 'C', captions: { instagram: { text: `ig ${id}` } } });
const NOW = '2026-11-12T06:30:00Z';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'interrupted-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ posts: [] }));
  const owners = new ProductBrands(brandsRoot);
  owners.claim('bb-acme', 'brandbasket', () => false);
  const stage = new CopyStage(dir, 'bb-acme');
  stage.open('week-01.json', [post('d1', '2026-11-16'), post('d2', '2026-11-17')]);
  return { root, brandsRoot, dir, owners, stage, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a draw lost halfway leaves its posts open again with a reason, so they can be drawn again', () => {
  const s = setup();
  try {
    s.stage.decide('week-01.json', 'd1', 'kept', 'u1');
    s.stage.markPostsDrawn('week-01.json', ['d1']);
    const before = s.stage.get('week-01.json');
    assert.equal(postLocked(before, before.posts[0]!), true, 'sent to be drawn: locked, with no picture');
    const reopened = recordInterruptedDraw(s.brandsRoot, { kind: 'draw', brand: 'bb-acme', planFile: 'week-01.json', postIds: ['d1'] });
    assert.deepEqual(reopened, ['d1']);
    const after = s.stage.get('week-01.json');
    assert.equal(after.notDrawn?.['d1']?.code, 'NO_PICTURE');
    assert.equal(postLocked(after, after.posts[0]!), false, 'open for keep, drop, edit and a new draw');
    assert.deepEqual(recordInterruptedDraw(s.brandsRoot, { kind: 'draw', brand: 'bb-acme', planFile: 'week-01.json', postIds: ['d1'] }), [], 'recorded once');
    assert.deepEqual(recordInterruptedDraw(s.brandsRoot, { kind: 'copy', brand: 'bb-acme', planFile: 'week-01.json' }), [], 'only a draw is looked at');
  } finally {
    s.done();
  }
});

test('the automatic pass leaves a post that was already sent to be drawn alone, quietly', () => {
  const s = setup();
  try {
    writeConnected(s.dir, ['instagram']);
    writeAutoPosting(s.dir, { channels: ['instagram'], safetyHours: 0, by: 'u1' }, new Date(NOW));
    s.stage.decide('week-01.json', 'd1', 'kept', 'u1');
    s.stage.markPostsDrawn('week-01.json', ['d1']);
    const logged: string[] = [];
    const actions = runAutoPosting({ brandsRoot: s.brandsRoot, owners: s.owners, now: new Date(NOW), log: (m) => logged.push(m) });
    assert.deepEqual(logged, [], 'no error for the locked post');
    assert.equal(actions[0]?.kept, 1, 'the other post is still kept');
    assert.equal(s.stage.get('week-01.json').posts.find((p) => p.postId === 'd2')?.state, 'kept');
    assert.equal(AUTO_POST_BY, 'system:auto-posting');
  } finally {
    s.done();
  }
});
