import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from './review-store.ts';
import { checkLeadTime, classifyWaiting, noticesFor, waitingPosts, type LeadTimeNotice } from './lead-time.ts';
import { ntfySender } from './owner-notice.ts';

const NOW = new Date('2026-11-05T12:00:00Z');
const H = 3_600_000;

test('a waiting poster is closing when its time is under a day away, lapsed when its time passed recently, and neither when far off or long gone', () => {
  const at = (hours: number): number => NOW.getTime() + hours * H;
  const waiting = [
    { postId: 'soon', at: at(5) }, { postId: 'tomorrow-late', at: at(23) }, { postId: 'next-week', at: at(24 * 7) },
    { postId: 'just-passed', at: at(-2) }, { postId: 'long-gone', at: at(-72) },
  ];
  const found = classifyWaiting(waiting, NOW.getTime());
  assert.deepEqual(found.closing.map((p) => p.postId), ['soon', 'tomorrow-late']);
  assert.deepEqual(found.lapsed.map((p) => p.postId), ['just-passed']);
});

test('a notice is made once per poster and kind, and says what to do in plain words', () => {
  const findings = { closing: [{ postId: 'a', at: NOW.getTime() + 3 * H }], lapsed: [{ postId: 'b', at: NOW.getTime() - H }] };
  const first = noticesFor('oyechats', findings, new Set(), NOW.getTime());
  assert.deepEqual(first.map((n) => [n.key, n.priority]), [['closing:a', 'high'], ['lapsed:b', 'high']]);
  assert.match(first[0]?.message ?? '', /in about 3 hours.*Review tab/);
  assert.match(first[1]?.message ?? '', /was not posted/);
  assert.deepEqual(noticesFor('oyechats', findings, new Set(['closing:a', 'lapsed:b']), NOW.getTime()), []);
});

function fixture(): { dir: string; store: ReviewStore; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'lead-'));
  const brandDir = join(dir, 'oyechats');
  mkdirSync(brandDir, { recursive: true });
  writeFileSync(join(brandDir, 'week-01.json'), JSON.stringify({ posts: [
    { id: 'soon', date: '2026-11-05T20:00:00Z' }, { id: 'approved', date: '2026-11-05T20:00:00Z' }, { id: 'late', date: '2026-11-05T10:00:00Z' },
    { id: 'far', date: '2026-11-20T10:00:00Z' }, { id: 'other-plan', date: '2026-11-05T20:00:00Z' },
  ] }));
  const store = new ReviewStore(brandDir, 'oyechats', () => NOW);
  const add = (postId: string, planFile: string) => store.addVersion({
    postId, planFile, headline: 'H', caption: 'C', ctaUrl: 'https://oyechats.com', factIds: [], evidence: [],
    imagePath: (() => { const p = join(dir, `${postId}.jpg`); writeFileSync(p, postId); return p; })(),
    validation: { accepted: true, readings: 1, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0,
  });
  for (const id of ['soon', 'approved', 'late', 'far']) add(id, 'week-01.json');
  add('other-plan', 'week-09.json');
  store.approve(store.history('approved')[0]!.version.versionId, 'owner');
  return { dir, store, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the waiting posters are those of the plan with a version waiting and none approved, each with its planned time', () => {
  const f = fixture();
  try {
    const waiting = waitingPosts(join(f.dir, 'oyechats'), 'oyechats', ['week-01.json'], NOW);
    assert.deepEqual(waiting.map((p) => p.postId).sort(), ['far', 'late', 'soon']);
    assert.equal(waitingPosts(join(f.dir, 'nowhere'), 'nowhere', ['week-01.json'], NOW).length, 0, 'no review queue, nothing to say');
  } finally {
    f.done();
  }
});

test('notices are sent once, a notice that was not delivered is tried again, and a failing sender never breaks the check', async () => {
  const f = fixture();
  try {
    const brandDir = join(f.dir, 'oyechats');
    const sent: LeadTimeNotice[] = [];
    const ok = async (n: LeadTimeNotice): Promise<boolean> => { sent.push(n); return true; };
    const first = await checkLeadTime(brandDir, 'oyechats', 'oyechats', ['week-01.json'], NOW, ok);
    assert.deepEqual(first.map((n) => n.title).sort(), ['Poster missed its time: oyechats', 'Poster waiting for approval: oyechats'], 'the far poster is not mentioned');
    assert.equal((await checkLeadTime(brandDir, 'oyechats', 'oyechats', ['week-01.json'], NOW, ok)).length, 0, 'the same notices are not sent again');
    assert.equal(sent.length, 2);
    assert.ok(existsSync(join(brandDir, 'notices.json')));
  } finally {
    f.done();
  }
  const g = fixture();
  try {
    const brandDir = join(g.dir, 'oyechats');
    const down = async (): Promise<boolean> => false;
    assert.equal((await checkLeadTime(brandDir, 'oyechats', 'oyechats', ['week-01.json'], NOW, down)).length, 0);
    assert.ok(!existsSync(join(brandDir, 'notices.json')), 'nothing is recorded as sent');
    const later = await checkLeadTime(brandDir, 'oyechats', 'oyechats', ['week-01.json'], NOW, async () => true);
    assert.equal(later.length, 2, 'they are sent when the sender works again');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(brandDir, 'notices.json'), 'utf8')).sent).sort(), ['closing:soon', 'lapsed:late']);
  } finally {
    g.done();
  }
});

test('the ntfy sender sends nothing without a topic, posts the message to the topic, and reports a refusal or a network failure as not delivered', async () => {
  const calls: Array<{ url: string; title: string | undefined }> = [];
  const fake = (status: number | 'throw'): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    if (status === 'throw') throw new Error('offline');
    calls.push({ url: String(url), title: (init?.headers as Record<string, string>)['Title'] });
    return new Response('', { status });
  }) as typeof fetch;
  assert.equal(await ntfySender({}, fake(200))({ title: 't', message: 'm' }), false);
  assert.equal(calls.length, 0);
  assert.equal(await ntfySender({ ALERT_NTFY_TOPIC: 'secret topic' }, fake(200))({ title: 'Poster – late', message: 'm' }), true);
  assert.equal(calls[0]?.url, 'https://ntfy.sh/secret%20topic');
  assert.equal(calls[0]?.title, 'Poster ? late', 'header text is plain ASCII');
  assert.equal(await ntfySender({ ALERT_NTFY_TOPIC: 'x' }, fake(500))({ title: 't', message: 'm' }), false);
  assert.equal(await ntfySender({ ALERT_NTFY_TOPIC: 'x' }, fake('throw'))({ title: 't', message: 'm' }), false);
});

test('a carousel waiting for approval is reported once, as the carousel (not once for each slide), and is no longer reported once it is approved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lead-carousel-'));
  try {
    const brandDir = join(dir, 'oyechats');
    mkdirSync(brandDir, { recursive: true });
    writeFileSync(join(brandDir, 'week-01.json'), JSON.stringify({ posts: [{ id: 'car1', date: '2026-11-05T20:00:00+05:30' }] }));
    const store = new ReviewStore(brandDir, 'oyechats');
    const picture = join(dir, 'p.jpg');
    writeFileSync(picture, 'picture');
    const base = { planFile: 'week-01.json', ctaUrl: 'https://oyechats.com', factIds: [], evidence: [], validation: { accepted: true, readings: 2, defects: [], reportFile: 'r.json' }, attempts: 1, costUsd: 0.01, imagePath: picture };
    for (const n of [1, 2, 3]) store.addVersion({ ...base, postId: `car1-s${n}`, headline: `Slide ${n}`, caption: '', carousel: { id: 'car1', position: n, count: 3 } });
    for (const network of ['instagram', 'linkedin']) store.addVersion({ ...base, postId: 'car1', network, headline: 'Topic', caption: `${network} caption`, carousel: { id: 'car1', position: 0, count: 3 } });
    assert.deepEqual(waitingPosts(brandDir, 'oyechats', ['week-01.json'], NOW).map((p) => p.postId), ['car1']);
    store.approveCarousel('car1', 'owner');
    assert.deepEqual(waitingPosts(brandDir, 'oyechats', ['week-01.json'], NOW), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
