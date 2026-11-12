import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopyStage, CopyStageError } from './copy-stage.ts';
import { JobStore } from './job-store.ts';
import { NOT_DRAWN_REASON, classifyNotDrawn } from './not-drawn.ts';
import { ProductBrands } from './product-brands.ts';
import { createReviewServer } from './review-server.ts';

const W1 = '2026-11-16';
const W2 = '2026-11-23';
const post = (id: string, date: string) => ({ postId: id, date, headline: `Headline ${id}`, caption: `Caption ${id}`, captions: { instagram: { text: `ig ${id}` } } });
const posts = [post('w1-d1', '2026-11-16'), post('w1-d2', '2026-11-17'), post('w2-d1', '2026-11-23')];
const code = (work: () => unknown): string | undefined => { try { work(); } catch (error) { return error instanceof CopyStageError ? error.code : String(error); } return undefined; };

test('why a topic has no picture is told in fixed words: a weak headline, a limit, or no picture that passed the checks', () => {
  assert.deepEqual(classifyNotDrawn({ status: 'dropped', reason: 'weak headline: it tells the reader nothing specific' }), { code: 'HEADLINE_TOO_WEAK', reason: NOT_DRAWN_REASON.HEADLINE_TOO_WEAK });
  assert.equal(classifyNotDrawn({ status: 'budget_stopped', reason: 'You have used your 7 Instagram pictures for this week.' }).code, 'PICTURE_LIMIT_REACHED');
  assert.equal(classifyNotDrawn({ status: 'rejected', reason: 'defect at /home/social/x' }).code, 'NO_PICTURE');
  assert.equal(classifyNotDrawn({ status: 'failed' }).code, 'NO_PICTURE');
  assert.doesNotMatch(JSON.stringify(classifyNotDrawn({ status: 'rejected', reason: 'defect at /home/social/x' })), /home|defect/, 'the engine\'s own words are never passed on');
});

test('a kept topic that got no picture is open again in a drawn week, one with a picture stays final, and dropping it clears the note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'undrawn-'));
  try {
    const stage = new CopyStage(dir, 'bb-acme');
    stage.open('week-01.json', posts);
    for (const id of ['w1-d1', 'w1-d2', 'w2-d1']) stage.decide('week-01.json', id, 'kept', 'u');
    stage.markWeekDrawn('week-01.json', W1);
    assert.equal(code(() => stage.decide('week-01.json', 'w1-d1', 'dropped', 'u')), 'ALREADY_DRAWN', 'final while it has no note');
    stage.setNotDrawn('week-01.json', { 'w1-d1': classifyNotDrawn({ status: 'dropped', reason: 'weak headline' }) });
    assert.equal(code(() => stage.edit('week-01.json', 'w1-d1', { headline: 'A better headline', caption: 'Caption w1-d1' }, 'u', () => undefined)), undefined, 'her headline edit is allowed');
    assert.equal(stage.get('week-01.json').posts.find((p) => p.postId === 'w1-d1')?.headline, 'A better headline');
    assert.equal(code(() => stage.decide('week-01.json', 'w1-d2', 'dropped', 'u')), 'ALREADY_DRAWN', 'a topic that has its picture stays final');
    assert.deepEqual(Object.keys(stage.get('week-01.json').notDrawn ?? {}), ['w1-d1']);
    stage.setNotDrawn('week-01.json', {}, ['w1-d1']);
    assert.equal(stage.get('week-01.json').notDrawn, undefined, 'a picture made later clears the note');
    assert.equal(code(() => stage.decide('week-01.json', 'w1-d1', 'dropped', 'u')), 'ALREADY_DRAWN', 'and it is final again');
    stage.setNotDrawn('week-01.json', { 'w1-d1': classifyNotDrawn({ status: 'failed' }) });
    stage.decide('week-01.json', 'w1-d1', 'dropped', 'u');
    assert.equal(stage.get('week-01.json').notDrawn, undefined, 'dropping a topic clears its note');
    // A week that was given up stays final, note or not.
    stage.markWeekLapsed('week-01.json', W2);
    stage.setNotDrawn('week-01.json', { 'w2-d1': classifyNotDrawn({ status: 'failed' }) });
    assert.equal(code(() => stage.decide('week-01.json', 'w2-d1', 'dropped', 'u')), 'ALREADY_DRAWN');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PRODUCT = 'brandbasket-secret-0123456789';

async function start() {
  const root = mkdtempSync(join(tmpdir(), 'undrawn-api-'));
  const brandsRoot = join(root, 'brands');
  const dir = join(brandsRoot, 'bb-acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Acme', website: 'https://acme.example' }));
  writeFileSync(join(dir, 'week-01.json'), JSON.stringify({ brand: 'bb-acme', timezone: '+05:30', renderMode: 'ai_v1', posts: posts.map((p) => ({ id: p.postId, date: `${p.date}T10:00:00+05:30`, painPoint: 'p', mode: 'ai', headline: p.headline, subline: '', caption: p.caption, hashtags: [], imagePrompt: 'a picture', variants: { instagram: { caption: p.captions.instagram.text, hashtags: [] } } })) }));
  new ProductBrands(brandsRoot).claim('bb-acme', 'brandbasket', () => false);
  const copy = new CopyStage(dir, 'bb-acme');
  copy.open('week-01.json', posts);
  const server = createReviewServer({ brandsRoot, secret: 'staff-secret-0123456789', jobsRoot: join(root, 'jobs'), products: [{ id: 'brandbasket', secret: PRODUCT }], ledgerFile: join(root, 'none.jsonl'), now: () => new Date('2026-11-12T06:30:00Z'), weeklyDrawEveryMs: 0 });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, method?: string): Promise<Response> => fetch(`${base}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${PRODUCT}`, 'X-Brand': 'bb-acme', 'X-Actor': 'brandbasket:user-42', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, copy, jobs: new JobStore(join(root, 'jobs')), done: async () => { await new Promise((resolve) => server.close(resolve)); rmSync(root, { recursive: true, force: true }); } };
}

type Listed = { batches: Array<{ weeks?: Array<{ from: string; state: string; notDrawn?: Array<{ postId: string; code: string; reason: string }> }>; posts: Array<{ postId: string; notDrawn?: { code: string; reason: string } }> }> };

test('after a draw that made nothing for a topic, the customer sees why per topic, can fix or drop it, and a retry draws only what is missing; the system never retries', async () => {
  const s = await start();
  try {
    for (const id of ['w1-d1', 'w1-d2']) assert.equal((await s.call(`/review/copy/bb-acme/week-01.json/${id}/keep`, {})).status, 200);
    // The draw of week 1 was asked for, ran, and made a picture for w1-d2 only (the weak headline of w1-d1 was dropped): it ended NOTHING_DRAWN-like, failed.
    const asked = await s.call('/review/copy/bb-acme/week-01.json/draw', { week: W1 });
    assert.equal(asked.status, 202);
    const job = ((await asked.json()) as { job: { id: string } }).job;
    s.copy.markWeekDrawn('week-01.json', W1);
    s.copy.setNotDrawn('week-01.json', { 'w1-d1': classifyNotDrawn({ status: 'dropped', reason: 'weak headline' }) });
    s.jobs.claim(1, 1);
    s.jobs.update(job.id, { state: 'failed', error: { code: 'PARTIAL_DRAW', message: '1 of 2 kept posts got no picture' } });

    const listed = (await (await s.call('/review/copy')).json()) as Listed;
    const week = listed.batches[0]?.weeks?.find((w) => w.from === W1);
    assert.equal(week?.state, 'drawn');
    assert.deepEqual(week?.notDrawn, [{ postId: 'w1-d1', code: 'HEADLINE_TOO_WEAK', reason: NOT_DRAWN_REASON.HEADLINE_TOO_WEAK }]);
    assert.deepEqual(listed.batches[0]?.posts.find((p) => p.postId === 'w1-d1')?.notDrawn, { code: 'HEADLINE_TOO_WEAK', reason: NOT_DRAWN_REASON.HEADLINE_TOO_WEAK });
    assert.equal(listed.batches[0]?.posts.find((p) => p.postId === 'w1-d2')?.notDrawn, undefined);

    // She changes the headline of the topic with no picture; the topic that has its picture stays final.
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d2/drop', {})).status, 409);
    const edit = await s.call('/review/copy/bb-acme/week-01.json/w1-d1/edit', { headline: 'Chat with your own documents', caption: 'Caption w1-d1' }, 'PUT');
    assert.equal(edit.status, 200, JSON.stringify(await edit.clone().json()));
    // The retry draws the week again for what is missing; the same week is a new job only because the first failed.
    const retry = await s.call('/review/copy/bb-acme/week-01.json/draw', { week: W1, retry: true });
    assert.equal(retry.status, 202, JSON.stringify(await retry.clone().json()));
    const second = ((await retry.json()) as { job: { id: string; week: string } }).job;
    assert.notEqual(second.id, job.id);
    assert.equal(second.week, W1);
    // While the retry is waiting, the topic is locked again.
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d1/drop', {})).status, 409);
    // A retry only after a failed draw: asking again while one waits is the same job.
    assert.equal(((await (await s.call('/review/copy/bb-acme/week-01.json/draw', { week: W1, retry: true })).json()) as { job: { id: string } }).job.id, second.id);
  } finally {
    await s.done();
  }
});

test('a week whose draw ran but left every kept topic without a picture is not_drawn, never drawn', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/review/copy/bb-acme/week-01.json/w1-d1/keep', {})).status, 200);
    s.copy.markWeekDrawn('week-01.json', W1);
    s.copy.setNotDrawn('week-01.json', { 'w1-d1': classifyNotDrawn({ status: 'dropped', reason: 'weak headline' }) });
    const state = async (): Promise<string | undefined> => ((await (await s.call('/review/copy')).json()) as Listed).batches[0]?.weeks?.find((w) => w.from === W1)?.state;
    assert.equal(await state(), 'not_drawn');
    s.copy.setNotDrawn('week-01.json', {}, ['w1-d1']);
    assert.equal(await state(), 'drawn', 'a picture made later makes it drawn');
  } finally {
    await s.done();
  }
});
