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

// Exporting is publishing, so these tests need the switch on (each test file runs in its own process).
process.env['SOCIAL_PUBLISHING_ENABLED'] = 'true';

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


function perNetworkBrand(platforms: string[], approve: string[]): { brandDir: string; publisher: string; store: ReviewStore; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'export-nets-'));
  const brandDir = join(root, 'brands', 'oyechats');
  const publisher = join(root, 'publisher');
  mkdirSync(join(brandDir, 'campaigns'), { recursive: true });
  const post = { id: 'w01-d1', date: '2099-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Answers from your own docs', subline: '', caption: 'Hook.\n\nFacts.', hashtags: ['#a'], imagePrompt: 'a picture' };
  writeFileSync(join(brandDir, 'week-01.json'), JSON.stringify({ brand: 'oyechats', timezone: '+05:30', renderMode: 'ai_v1', posts: [post] }));
  writeFileSync(join(brandDir, 'campaigns', 'abc.json'), JSON.stringify({ id: 'abc', plan: { platforms }, batches: [{ index: 0, dates: ['2099-11-10'], status: 'done', weekFile: 'week-01.json' }] }));
  const square = join(root, 'square.jpg');
  const wide = join(root, 'wide.jpg');
  writeFileSync(square, 'square picture');
  writeFileSync(wide, 'wide picture');
  const store = new ReviewStore(brandDir, 'oyechats');
  for (const [network, image] of [['instagram', square], ['facebook', square], ['linkedin', wide]] as const) {
    const v = store.addVersion({ postId: 'w01-d1', planFile: 'week-01.json', network, headline: 'Answers from your own docs', caption: `${network} caption`, ctaUrl: 'https://oyechats.com', factIds: [], evidence: [], imagePath: image, validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.02 });
    if (approve.includes(network)) store.approve(v.versionId, 'owner');
  }
  return { brandDir, publisher, store, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a poster made per network is released as one post: the square picture and Instagram caption as the main ones, each other network with its own caption, the wide one with its own picture', async () => {
  const b = perNetworkBrand(['instagram', 'facebook', 'linkedin'], ['instagram', 'facebook', 'linkedin']);
  try {
    const [post] = await exportToPublisher(b.brandDir, b.publisher);
    assert.deepEqual(post?.channels, ['instagram', 'facebook', 'linkedin']);
    assert.equal(post?.caption, 'instagram caption');
    assert.equal(post?.fromPlan, true);
    assert.deepEqual(Object.keys(post?.variants ?? {}).sort(), ['facebook', 'linkedin']);
    assert.deepEqual(post?.variants?.['facebook'], { caption: 'facebook caption' }, 'same square picture: only the caption differs');
    assert.match(post?.variants?.['linkedin']?.image ?? '', /^\/posts\/oyechats\/[0-9a-f]{32}\.jpg$/);
    assert.notEqual(post?.variants?.['linkedin']?.image, post?.image);
    assert.equal(readdirSync(join(b.publisher, 'public', 'posts', 'oyechats')).length, 2, 'two pictures: the square one shared by two networks, and the wide one');
  } finally {
    b.done();
  }
});

test('only the networks whose own version was approved, and that the plan allows, receive the post', async () => {
  const onlyInstagramAndLinkedin = perNetworkBrand(['instagram', 'linkedin'], ['instagram', 'facebook', 'linkedin']);
  try {
    const [post] = await exportToPublisher(onlyInstagramAndLinkedin.brandDir, onlyInstagramAndLinkedin.publisher);
    assert.deepEqual(post?.channels, ['instagram', 'linkedin'], 'facebook was approved but the plan does not include it');
  } finally {
    onlyInstagramAndLinkedin.done();
  }
  const linkedinOnly = perNetworkBrand(['instagram', 'linkedin'], ['linkedin']);
  try {
    const [post] = await exportToPublisher(linkedinOnly.brandDir, linkedinOnly.publisher);
    assert.deepEqual(post?.channels, ['linkedin'], 'instagram was not approved, so it does not get it');
    assert.equal(post?.caption, 'linkedin caption', 'the approved network\'s version is the main one');
    assert.deepEqual(post?.variants, undefined);
  } finally {
    linkedinOnly.done();
  }
  const nothing = perNetworkBrand(['instagram', 'linkedin'], []);
  try {
    assert.deepEqual(await exportToPublisher(nothing.brandDir, nothing.publisher), []);
  } finally {
    nothing.done();
  }
});

test('a poster made per network goes to the exact account a plan was bound to, and to the bare network for one that was not', async () => {
  const b = perNetworkBrand(['instagram', 'linkedin'], ['instagram', 'linkedin']);
  try {
    writeFileSync(join(b.brandDir, 'campaigns', 'abc.json'), JSON.stringify({ id: 'abc', plan: { platforms: ['instagram', 'linkedin'], channelIds: ['linkedin:abc'] }, batches: [{ index: 0, dates: ['2099-11-10'], status: 'done', weekFile: 'week-01.json' }] }));
    const [post] = await exportToPublisher(b.brandDir, b.publisher);
    assert.deepEqual(post?.channels, ['instagram', 'linkedin:abc']);
    assert.deepEqual(Object.keys(post?.variants ?? {}), ['linkedin'], 'the picture and caption of a network stay under the network name');
  } finally {
    b.done();
  }
});

test('a plan that allows none of the approved networks releases nothing', async () => {
  const b = perNetworkBrand(['google'], ['instagram', 'linkedin']);
  try {
    assert.deepEqual(await exportToPublisher(b.brandDir, b.publisher), []);
  } finally {
    b.done();
  }
});

test('a plan bound to exact accounts exports its posters to those accounts, and a platform left unbound goes by name', async () => {
  const b = aiBrand(['linkedin', 'facebook']);
  try {
    writeFileSync(join(b.brandDir, 'campaigns', 'abc.json'), JSON.stringify({ id: 'abc', plan: { platforms: ['linkedin', 'facebook'], channelIds: ['linkedin:abc'] }, batches: [{ index: 0, dates: ['2099-11-10'], status: 'done', weekFile: 'week-01.json' }] }));
    const posts = await exportToPublisher(b.brandDir, b.publisher);
    assert.deepEqual(posts.map((p) => (p as { channels?: string[] }).channels), [['linkedin:abc', 'facebook']]);
  } finally {
    b.done();
  }
});

function carouselBrand(): { brandDir: string; publisher: string; store: ReviewStore; redraw: () => void; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'export-carousel-'));
  const brandDir = join(root, 'brands', 'oyechats');
  const publisher = join(root, 'publisher');
  mkdirSync(join(brandDir, 'campaigns'), { recursive: true });
  const post = { id: 'car1', date: '2099-11-10T10:00:00+05:30', painPoint: 'p', mode: 'ai', headline: 'Choosing', subline: '', caption: 'Choosing a curry', hashtags: [], imagePrompt: 'a carousel' };
  writeFileSync(join(brandDir, 'week-01.json'), JSON.stringify({ brand: 'oyechats', timezone: '+05:30', renderMode: 'ai_v1', posts: [post] }));
  writeFileSync(join(brandDir, 'campaigns', 'abc.json'), JSON.stringify({ id: 'abc', plan: { platforms: ['instagram', 'linkedin'] }, batches: [{ index: 0, dates: ['2099-11-10'], status: 'done', weekFile: 'week-01.json' }] }));
  const store = new ReviewStore(brandDir, 'oyechats');
  const base = { planFile: 'week-01.json', ctaUrl: 'https://oyechats.com', factIds: [], evidence: [], validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.016 };
  const slide = (n: number, text = `slide ${n}`) => {
    const file = join(root, `s${n}-${text.replace(/\W/g, '')}.jpg`);
    writeFileSync(file, text);
    return store.addVersion({ ...base, postId: `car1-s${n}`, headline: `Slide ${n}`, caption: '', imagePath: file, carousel: { id: 'car1', position: n, count: 3 } });
  };
  for (const n of [1, 2, 3]) slide(n);
  const cover = join(root, 'cover.jpg');
  writeFileSync(cover, 'slide 1');
  for (const network of ['instagram', 'linkedin']) store.addVersion({ ...base, postId: 'car1', network, headline: 'Choosing', caption: `${network} caption`, imagePath: cover, carousel: { id: 'car1', position: 0, count: 3 } });
  return { brandDir, publisher, store, redraw: () => void slide(2, 'slide 2 redrawn'), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('an approved carousel is exported as one post with every slide picture in order, and a caption for each network', async () => {
  const b = carouselBrand();
  try {
    b.store.approveCarousel('car1', 'owner');
    const posts = await exportToPublisher(b.brandDir, b.publisher);
    assert.equal(posts.length, 1);
    const [post] = posts;
    assert.equal(post?.images?.length, 3);
    assert.equal(new Set(post?.images).size, 3);
    assert.equal(post?.image, post?.images?.[0]);
    assert.ok(post?.images?.every((p) => /^\/posts\/oyechats\/[0-9a-f]{32}\.jpg$/.test(p)));
    assert.equal(post?.caption, 'instagram caption');
    assert.deepEqual(post?.variants, { linkedin: { caption: 'linkedin caption' } });
    assert.deepEqual(post?.channels, ['instagram', 'linkedin']);
    assert.equal(readdirSync(join(b.publisher, 'public', 'posts', 'oyechats')).length, 3);
  } finally {
    b.done();
  }
});

test('a carousel that is not fully approved is not exported at all, never as its cover alone', async () => {
  const b = carouselBrand();
  try {
    assert.deepEqual(await exportToPublisher(b.brandDir, b.publisher), [], 'nothing approved');
    b.store.approveCarousel('car1', 'owner');
    b.redraw();
    assert.deepEqual(await exportToPublisher(b.brandDir, b.publisher), [], 'a slide was redrawn after approval and waits for approval again');
    b.store.approveCarousel('car1', 'owner');
    assert.equal((await exportToPublisher(b.brandDir, b.publisher))[0]?.images?.length, 3);
  } finally {
    b.done();
  }
});
