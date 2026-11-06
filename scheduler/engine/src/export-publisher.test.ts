import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseScheduleModule, posterFileName, scheduleModule } from './export-publisher.ts';

test('the schedule module round-trips and rejects hand-written files', () => {
  const posts = [{ brand: 'b', id: 'b-w01-d1', date: '2026-10-29T10:00:00+05:30', caption: 'Hi\n\n#a', image: '/posts/b/x.jpg' }];
  assert.deepEqual(parseScheduleModule(scheduleModule(posts)), posts);
  assert.throws(() => parseScheduleModule('export const schedule = {"posts": []};\n'), /not generated/);
});

test('the schedule module keeps old posts whose poster was pruned (image: null)', () => {
  const posts = [{ brand: 'b', id: 'b-w01-d1', date: '2026-01-01T10:00:00+05:30', caption: 'Old', image: null }];
  assert.deepEqual(parseScheduleModule(scheduleModule(posts)), posts);
});

test('posterFileName is stable for the same image and different for others', () => {
  const a = Buffer.from('image-a');
  assert.equal(posterFileName(a), posterFileName(Buffer.from('image-a')));
  assert.notEqual(posterFileName(a), posterFileName(Buffer.from('image-b')));
});

test('posterFileName is a 32-character hex name that reveals nothing about the post', () => {
  const name = posterFileName(Buffer.from('w01-d1'));
  assert.match(name, /^[0-9a-f]{32}\.jpg$/);
  assert.ok(!name.includes('w01'));
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportToPublisher } from './export-publisher.ts';
import { ReviewStore } from './review-store.ts';

function aiBrand(platforms?: string[]): { root: string; brandDir: string; publisher: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'export-'));
  const brandDir = join(root, 'brands', 'oyechats');
  const publisher = join(root, 'publisher');
  mkdirSync(brandDir, { recursive: true });
  const post = (id: string, date: string) => ({ id, date, painPoint: 'p', mode: 'ai', headline: 'Answers from your own docs', subline: '', caption: 'Hook.\n\nFacts.', hashtags: ['#a'], imagePrompt: 'a picture' });
  writeFileSync(join(brandDir, 'week-01.json'), JSON.stringify({ brand: 'oyechats', timezone: '+05:30', renderMode: 'ai_v1', posts: [post('w01-d1', '2099-11-10T10:00:00+05:30'), post('w01-d2', '2099-11-12T10:00:00+05:30')] }));
  // The campaign runner's record of which plan (and so which platforms) wrote week-01.json.
  if (platforms) {
    mkdirSync(join(brandDir, 'campaigns'), { recursive: true });
    writeFileSync(join(brandDir, 'campaigns', 'abc.json'), JSON.stringify({ id: 'abc', plan: { platforms }, batches: [{ index: 0, dates: ['2099-11-10'], status: 'done', weekFile: 'week-01.json' }] }));
  }
  const picture = join(root, 'p.jpg');
  writeFileSync(picture, 'approved picture');
  const store = new ReviewStore(brandDir, 'oyechats');
  for (const postId of ['w01-d1', 'w01-d2']) {
    const v = store.addVersion({ postId, planFile: 'week-01.json', headline: 'Answers from your own docs', caption: `Approved caption of ${postId}`, ctaUrl: 'https://oyechats.com', factIds: [], evidence: [], imagePath: picture, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 });
    if (postId === 'w01-d1') store.approve(v.versionId, 'owner');
  }
  return { root, brandDir, publisher, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('an approved AI poster is exported with the platforms the owner chose, and an unapproved one is not exported at all', async () => {
  const b = aiBrand(['instagram', 'facebook']);
  try {
    const posts = await exportToPublisher(b.brandDir, b.publisher);
    assert.deepEqual(posts.map((p) => p.id), ['oyechats-w01-d1']);
    assert.deepEqual(posts[0]?.channels, ['instagram', 'facebook']);
    assert.equal(posts[0]?.fromPlan, true, 'a plan\'s post is marked, so it never goes to the shared account');
    assert.equal(posts[0]?.caption, 'Approved caption of w01-d1');
    assert.match(readFileSync(join(b.publisher, 'data', 'schedule.ts'), 'utf8'), /"channels": \[\s*"instagram",\s*"facebook"\s*\]/);
  } finally {
    b.done();
  }
});

test('with no campaign the export has no channel list, so the post goes to every connected channel as before', async () => {
  const b = aiBrand();
  try {
    const posts = await exportToPublisher(b.brandDir, b.publisher);
    assert.equal(posts[0]?.channels, undefined);
  } finally {
    b.done();
  }
});

test('two plans of one client keep their own platforms: each week file goes where its own plan says', async () => {
  const b = aiBrand(['instagram']);
  try {
    // A second plan (LinkedIn only) wrote week-02.json, with its own approved poster.
    const post = { id: 'w02-d1', date: '2099-11-11T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Answers from your own docs', subline: '', caption: 'Hook.\n\nFacts.', hashtags: ['#a'], imagePrompt: 'a picture' };
    writeFileSync(join(b.brandDir, 'week-02.json'), JSON.stringify({ brand: 'oyechats', timezone: '+05:30', renderMode: 'ai_v1', posts: [post] }));
    writeFileSync(join(b.brandDir, 'campaigns', 'def.json'), JSON.stringify({ id: 'def', plan: { platforms: ['linkedin'] }, batches: [{ index: 0, dates: ['2099-11-11'], status: 'done', weekFile: 'week-02.json' }] }));
    const store = new ReviewStore(b.brandDir, 'oyechats');
    const v = store.addVersion({ postId: 'w02-d1', planFile: 'week-02.json', headline: 'Answers from your own docs', caption: 'Approved caption of w02-d1', ctaUrl: 'https://oyechats.com', factIds: [], evidence: [], imagePath: join(b.root, 'p.jpg'), validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 });
    store.approve(v.versionId, 'owner');
    const posts = await exportToPublisher(b.brandDir, b.publisher);
    assert.deepEqual(posts.map((p) => [p.id, p.channels]), [['oyechats-w01-d1', ['instagram']], ['oyechats-w02-d1', ['linkedin']]]);
  } finally {
    b.done();
  }
});

test('on a site the campaign runner manages, an AI poster that no plan record accounts for is held back, not sent to every channel', async () => {
  const b = aiBrand(['instagram']);
  try {
    // The record that tied week-01.json to its plan is gone; another plan's record exists, so the site is runner-managed.
    writeFileSync(join(b.brandDir, 'campaigns', 'abc.json'), JSON.stringify({ id: 'abc', plan: { platforms: ['instagram'] }, batches: [{ index: 0, dates: ['2099-11-10'], status: 'done', weekFile: 'week-09.json' }] }));
    assert.deepEqual(await exportToPublisher(b.brandDir, b.publisher), []);
  } finally {
    b.done();
  }
});

test('an approved AI poster is marked as having its own time, so the frequent run sends it then and the once-a-day run does not leave it for the next morning', async () => {
  const b = aiBrand(['instagram']);
  try {
    const posts = await exportToPublisher(b.brandDir, b.publisher);
    assert.equal(posts[0]?.ownTime, true);
    assert.match(readFileSync(join(b.publisher, 'data', 'schedule.ts'), 'utf8'), /"ownTime": true/);
  } finally {
    b.done();
  }
});

test('an approved AI poster with no plan record behind it is not marked as made from a plan', async () => {
  const b = aiBrand();
  try {
    const posts = await exportToPublisher(b.brandDir, b.publisher);
    assert.equal(posts[0]?.fromPlan, undefined);
    assert.equal(posts[0]?.channels, undefined);
  } finally {
    b.done();
  }
});

test('posters are filed under the client\'s own name, not the site folder\'s, so the client\'s channels match them; entries an earlier version filed under the folder name are cleared', async () => {
  const b = aiBrand(['instagram']);
  try {
    mkdirSync(join(b.publisher, 'data'), { recursive: true });
    const entry = (over: Record<string, unknown>) => ({ date: '2099-11-01T10:00:00+05:30', caption: 'c', image: null, ...over });
    // The schedule already holds: an earlier export filed under the folder name, a post of another client, and a weekly-job post that happens to share the folder name.
    writeFileSync(join(b.publisher, 'data', 'schedule.ts'), scheduleModule([
      entry({ brand: 'oyechats', id: 'oyechats-w01-d9', ownTime: true }),
      entry({ brand: 'oyechats', id: 'oyechats-weekly-1' }),
      entry({ brand: 'other', id: 'other-w01-d1', ownTime: true }),
    ] as never));
    const posts = await exportToPublisher(b.brandDir, b.publisher, undefined, { brand: 'oye-chats' });
    assert.deepEqual(posts.map((p) => [p.brand, p.id]), [['oye-chats', 'oye-chats-w01-d1']]);
    assert.match(posts[0]?.image ?? '', /^\/posts\/oye-chats\//);
    assert.ok(readdirSync(join(b.publisher, 'public', 'posts', 'oye-chats')).length === 1, 'the picture is under the client\'s name');
    assert.ok(!existsSync(join(b.publisher, 'public', 'posts', 'oyechats')), 'nothing is filed under the folder name');
    const ids = (parseScheduleModule(readFileSync(join(b.publisher, 'data', 'schedule.ts'), 'utf8')) as Array<{ id: string }>).map((p) => p.id).sort();
    assert.deepEqual(ids, ['other-w01-d1', 'oye-chats-w01-d1', 'oyechats-weekly-1'], 'the stray entry from an earlier export is gone; another client\'s and a weekly post are kept');
  } finally {
    b.done();
  }
});

test('only the week files a client\'s plans made are exported when they are named', async () => {
  const b = aiBrand(['instagram']);
  try {
    const none = await exportToPublisher(b.brandDir, b.publisher, undefined, { brand: 'oye-chats', weekFiles: ['week-09.json'] });
    assert.deepEqual(none, [], 'a week file nobody asked for is left out');
    const some = await exportToPublisher(b.brandDir, b.publisher, undefined, { brand: 'oye-chats', weekFiles: ['week-01.json'] });
    assert.equal(some.length, 1);
  } finally {
    b.done();
  }
});

